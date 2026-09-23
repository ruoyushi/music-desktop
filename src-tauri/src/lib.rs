use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent,
    AppHandle, WebviewUrl, WebviewWindowBuilder,
};

const API_BASE: &str = "https://music-api.gdstudio.xyz/api.php";
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MusicDesktop/0.1";

// ---------- 安装目录 cache_dir/audio ----------

/// 可执行文件所在目录下的 `cache_dir/audio`
fn audio_cache_dir() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("无法定位程序路径: {e}"))?;
    let parent = exe
        .parent()
        .ok_or_else(|| "无法解析安装目录".to_string())?;
    let dir = parent.join("cache_dir").join("audio");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建缓存目录失败: {e}"))?;
    Ok(dir)
}

fn sanitize_cache_token(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
            out.push(c);
        } else {
            out.push('_');
        }
    }
    if out.is_empty() {
        out.push_str("unknown");
    }
    // 防止过长文件名
    if out.len() > 80 {
        out.truncate(80);
    }
    out
}

fn cache_stem(source: &str, id: &str, br: u32) -> String {
    format!(
        "{}_{}_{}",
        sanitize_cache_token(source),
        sanitize_cache_token(id),
        br
    )
}

/// 在缓存目录中查找已存在的音频文件
fn find_existing_cache_file(dir: &Path, stem: &str) -> Option<PathBuf> {
    let rd = std::fs::read_dir(dir).ok()?;
    for ent in rd.flatten() {
        let path = ent.path();
        if !path.is_file() {
            continue;
        }
        let name = path.file_name()?.to_string_lossy();
        // 跳过下载中的临时文件
        if name.ends_with(".part") {
            continue;
        }
        if let Some(file_stem) = path.file_stem().and_then(|s| s.to_str()) {
            if file_stem == stem {
                // 过滤空文件
                if let Ok(meta) = path.metadata() {
                    if meta.len() > 0 {
                        return Some(path);
                    }
                }
            }
        }
    }
    None
}

fn ext_from_url(url: &str) -> Option<&'static str> {
    let path = url.split('?').next().unwrap_or(url);
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".flac") {
        Some("flac")
    } else if lower.ends_with(".m4a") || lower.ends_with(".mp4") {
        Some("m4a")
    } else if lower.ends_with(".ogg") || lower.ends_with(".oga") {
        Some("ogg")
    } else if lower.ends_with(".wav") {
        Some("wav")
    } else if lower.ends_with(".aac") {
        Some("aac")
    } else if lower.ends_with(".mp3") {
        Some("mp3")
    } else {
        None
    }
}

fn ext_from_content_type(ct: &str) -> Option<&'static str> {
    let ct = ct.to_ascii_lowercase();
    if ct.contains("flac") {
        Some("flac")
    } else if ct.contains("mp4") || ct.contains("m4a") || ct.contains("aac") {
        Some("m4a")
    } else if ct.contains("ogg") {
        Some("ogg")
    } else if ct.contains("wav") {
        Some("wav")
    } else if ct.contains("mpeg") || ct.contains("mp3") {
        Some("mp3")
    } else {
        None
    }
}

/// 规范化播放直链（协议相对路径等）
fn normalize_media_url(url: &str) -> String {
    let u = url.trim();
    if u.starts_with("//") {
        format!("https:{u}")
    } else {
        u.to_string()
    }
}

/// 按音源补 Referer，降低 CDN 403 概率
fn referer_for_source(source: &str) -> &'static str {
    let s = source.to_ascii_lowercase();
    if s.contains("netease") {
        "https://music.163.com/"
    } else if s.contains("tencent") || s.contains("qq") {
        "https://y.qq.com/"
    } else if s.contains("kuwo") {
        "https://www.kuwo.cn/"
    } else if s.contains("kugou") {
        "https://www.kugou.com/"
    } else if s.contains("bilibili") {
        "https://www.bilibili.com/"
    } else if s.contains("migu") {
        "https://music.migu.cn/"
    } else {
        "https://music.gdstudio.xyz/"
    }
}

async fn download_bytes_with_headers(
    url: &str,
    source: &str,
) -> Result<(Vec<u8>, String), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())?;

    let referer = referer_for_source(source);
    let resp = client
        .get(url)
        .header("User-Agent", UA)
        .header("Accept", "*/*")
        .header("Referer", referer)
        .header("Origin", referer.trim_end_matches('/'))
        .send()
        .await
        .map_err(|e| format!("缓存下载失败: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("缓存下载 HTTP {}", resp.status()));
    }

    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("读取音频失败: {e}"))?;
    if bytes.is_empty() {
        return Err("缓存内容为空".into());
    }
    // 过小可能是错误页/JSON，不当作音频
    if bytes.len() < 2048 {
        let head = String::from_utf8_lossy(&bytes[..bytes.len().min(200)]);
        if head.contains('<') || head.contains('{') || head.contains("error") {
            return Err(format!("缓存响应不像音频文件（{} 字节）", bytes.len()));
        }
    }

    Ok((bytes.to_vec(), content_type))
}

/// 代理 GD Studio API，规避 WebView CORS
#[tauri::command]
async fn proxy_api(params: HashMap<String, String>) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(API_BASE)
        .query(&params)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("API HTTP {}", resp.status()));
    }

    let text = resp.text().await.map_err(|e| e.to_string())?;
    if text.trim().is_empty() || text.trim() == "null" {
        return Ok(Value::Null);
    }

    serde_json::from_str(&text).map_err(|e| format!("JSON parse error: {e}; body={text}"))
}

/// 将音频直链下载到用户选择的路径
#[tauri::command]
async fn download_file(url: String, path: String) -> Result<(), String> {
    if url.trim().is_empty() {
        return Err("下载地址为空".into());
    }
    let dest = PathBuf::from(&path);
    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
        }
    }

    let url = normalize_media_url(&url);
    let (bytes, _) = download_bytes_with_headers(&url, "netease").await?;
    std::fs::write(&dest, &bytes).map_err(|e| format!("写入文件失败: {e}"))?;
    Ok(())
}

/// 返回音频缓存目录（安装目录/cache_dir/audio）
#[tauri::command]
fn get_audio_cache_dir() -> Result<String, String> {
    audio_cache_dir().map(|p| p.to_string_lossy().into_owned())
}

/// 若已缓存则返回绝对路径，否则 null
#[tauri::command]
fn find_cached_audio(source: String, id: String, br: u32) -> Result<Option<String>, String> {
    let dir = audio_cache_dir()?;
    let stem = cache_stem(&source, &id, br);
    Ok(find_existing_cache_file(&dir, &stem).map(|p| p.to_string_lossy().into_owned()))
}

/// 下载远程音频到缓存目录；已存在则直接返回路径
#[tauri::command]
async fn cache_audio_file(
    source: String,
    id: String,
    br: u32,
    url: String,
) -> Result<String, String> {
    if url.trim().is_empty() {
        return Err("下载地址为空".into());
    }

    let url = normalize_media_url(&url);
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(format!("仅支持 http(s) 音频地址，当前: {url}"));
    }

    let dir = audio_cache_dir()?;
    let stem = cache_stem(&source, &id, br);
    if let Some(existing) = find_existing_cache_file(&dir, &stem) {
        return Ok(existing.to_string_lossy().into_owned());
    }

    let (bytes, content_type) = download_bytes_with_headers(&url, &source).await?;

    let ext = ext_from_url(&url)
        .or_else(|| ext_from_content_type(&content_type))
        .unwrap_or("mp3");

    let final_path = dir.join(format!("{stem}.{ext}"));
    let part_path = dir.join(format!("{stem}.{ext}.part"));

    // 下载期间若已被其它任务写好，直接复用
    if let Some(existing) = find_existing_cache_file(&dir, &stem) {
        return Ok(existing.to_string_lossy().into_owned());
    }

    std::fs::write(&part_path, &bytes).map_err(|e| format!("写入缓存失败: {e}"))?;
    if final_path.exists() {
        let _ = std::fs::remove_file(&final_path);
    }
    if let Err(e) = std::fs::rename(&part_path, &final_path) {
        // 部分环境 rename 失败时直接 copy
        if let Err(e2) = std::fs::copy(&part_path, &final_path) {
            let _ = std::fs::remove_file(&part_path);
            return Err(format!("写入缓存失败: {e}; {e2}"));
        }
        let _ = std::fs::remove_file(&part_path);
    }

    eprintln!(
        "[audio-cache] saved {} ({} bytes) from {}",
        final_path.display(),
        bytes.len(),
        url
    );

    Ok(final_path.to_string_lossy().into_owned())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheStats {
    path: String,
    file_count: u64,
    total_bytes: u64,
}

#[tauri::command]
fn get_audio_cache_stats() -> Result<CacheStats, String> {
    let dir = audio_cache_dir()?;
    let mut file_count = 0u64;
    let mut total_bytes = 0u64;
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for ent in rd.flatten() {
            let path = ent.path();
            if !path.is_file() {
                continue;
            }
            let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
            if name.ends_with(".part") {
                continue;
            }
            if let Ok(meta) = path.metadata() {
                file_count += 1;
                total_bytes += meta.len();
            }
        }
    }
    Ok(CacheStats {
        path: dir.to_string_lossy().into_owned(),
        file_count,
        total_bytes,
    })
}

/// 清空音频缓存，返回删除的文件数
#[tauri::command]
fn clear_audio_cache() -> Result<u64, String> {
    let dir = audio_cache_dir()?;
    let mut removed = 0u64;
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for ent in rd.flatten() {
            let path = ent.path();
            if path.is_file() && std::fs::remove_file(&path).is_ok() {
                removed += 1;
            }
        }
    }
    Ok(removed)
}

/// macOS：让歌词窗压在其它应用的全屏窗口之上。
/// Chromium 全屏窗口会压在普通置顶窗口之上，所以这里需要三件事：
/// FullScreenAuxiliary + CanJoinAllSpaces（加入他人全屏所在的空间），
/// 以及远高于普通置顶的窗口层级（NSScreenSaverWindowLevel）。
#[cfg(target_os = "macos")]
fn elevate_lyric_window_over_fullscreen(
    app: &AppHandle,
    win: &tauri::WebviewWindow,
) -> Result<(), String> {
    use objc2_app_kit::{NSScreenSaverWindowLevel, NSWindow, NSWindowCollectionBehavior};

    let ns_window = win
        .ns_window()
        .map_err(|e| format!("获取歌词窗口句柄失败: {e}"))? as usize;

    app.run_on_main_thread(move || {
        let ns_window = ns_window as *mut NSWindow;
        if ns_window.is_null() {
            return;
        }
        // SAFETY: 指针来自 tauri 的 ns_window()，且只在主线程访问 AppKit 对象。
        unsafe {
            let ns_window = &*ns_window;
            let behavior = ns_window.collectionBehavior()
                | NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary;
            ns_window.setCollectionBehavior(behavior);
            ns_window.setLevel(NSScreenSaverWindowLevel);
            ns_window.setHidesOnDeactivate(false);
            ns_window.orderFrontRegardless();
        }
    })
    .map_err(|e| format!("设置歌词跨全屏悬浮失败: {e}"))
}

/// macOS：首次打开时把歌词窗放到副屏（外接屏）底部居中；没有副屏时才落回主屏。
#[cfg(target_os = "macos")]
fn place_lyric_on_secondary_display(
    app: &AppHandle,
    win: &tauri::WebviewWindow,
) -> Result<(), String> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSScreen, NSWindow};
    use objc2_foundation::NSPoint;

    let ns_window = win
        .ns_window()
        .map_err(|e| format!("获取歌词窗口句柄失败: {e}"))? as usize;

    app.run_on_main_thread(move || {
        let ns_window = ns_window as *mut NSWindow;
        if ns_window.is_null() {
            return;
        }
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        // SAFETY: 指针来自 tauri 的 ns_window()，且只在主线程访问 AppKit 对象。
        unsafe {
            let ns_window = &*ns_window;
            let screens = NSScreen::screens(mtm);
            let main = NSScreen::mainScreen(mtm);
            let main_origin = main.as_ref().map(|s| s.frame().origin);

            let mut target = main;
            for screen in screens.iter() {
                let origin = screen.frame().origin;
                let is_main = match main_origin {
                    Some(m) => m.x == origin.x && m.y == origin.y,
                    None => true,
                };
                if !is_main {
                    target = Some(screen);
                    break;
                }
            }

            let Some(target) = target else {
                return;
            };
            let visible = target.visibleFrame();
            let frame = ns_window.frame();
            let x = visible.origin.x + (visible.size.width - frame.size.width) / 2.0;
            let y = visible.origin.y + (visible.size.height * 0.08).max(24.0);

            ns_window.setFrameOrigin(NSPoint::new(x, y));
        }
    })
    .map_err(|e| format!("设置歌词窗位置失败: {e}"))
}

/// macOS：歌词窗的“守卫”。
/// Chrome 进入全屏会新建一个“空间”，已经存在的窗口不会被自动放进去，
/// 所以这里持续盯着窗口：先重新排序，尝试让 WindowServer 把它放回当前空间；
/// 若仍然不可见，就重建一次窗口（新窗口会直接落在当前全屏空间里）。
/// 所以这里持续盯着窗口，被别的窗口盖住就重新置顶（系统层级 + 重新排序）。

#[cfg(target_os = "macos")]
static LYRIC_KEEPER_RUNNING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[cfg(target_os = "macos")]
fn start_lyric_window_keeper(app: &AppHandle) {
    use objc2_app_kit::{
        NSScreenSaverWindowLevel, NSWindow, NSWindowCollectionBehavior, NSWindowOcclusionState,
    };
    use std::sync::atomic::Ordering;
    use std::time::Duration;
    if LYRIC_KEEPER_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }

    let app = app.clone();
    std::thread::spawn(move || {
        let mut missing_ticks = 0u32;
        loop {
            std::thread::sleep(Duration::from_millis(1500));
            if app.get_webview_window("lyric").is_none() {
                missing_ticks += 1;
                if missing_ticks > 6 {
                    break;
                }
                continue;
            }
            missing_ticks = 0;
            let app_for_tick = app.clone();
            let _ = app.run_on_main_thread(move || {
                let Some(win) = app_for_tick.get_webview_window("lyric") else {
                    return;
                };
                let Ok(ptr) = win.ns_window() else {
                    return;
                };
                // SAFETY: 句柄来自 tauri，且只在主线程访问 AppKit 对象。
                let w = unsafe { &*(ptr as *mut NSWindow) };
                let wanted = NSWindowCollectionBehavior::CanJoinAllSpaces
                    | NSWindowCollectionBehavior::FullScreenAuxiliary
                    | NSWindowCollectionBehavior::IgnoresCycle;
                if w.level() != NSScreenSaverWindowLevel {
                    w.setLevel(NSScreenSaverWindowLevel);
                }
                if !w.collectionBehavior().contains(wanted) {
                    w.setCollectionBehavior(w.collectionBehavior() | wanted);
                }
                let visible = w.occlusionState().contains(NSWindowOcclusionState::Visible);
                if visible {
                    return;
                }
                // 被别的窗口盖住时重新排序，尽量把它顶回最前面。
                w.setLevel(NSScreenSaverWindowLevel);
                w.orderFrontRegardless();
            });
        }
        LYRIC_KEEPER_RUNNING.store(false, Ordering::SeqCst);
    });
}

/// 创建（或重建）桌面歌词窗口，并完成置顶 / 跨全屏 / 定位。
fn create_lyric_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    let win = WebviewWindowBuilder::new(
        app,
        "lyric",
        WebviewUrl::App("index.html#/lyric".into()),
    )
    .title("桌面歌词")
    .inner_size(480.0, 200.0)
    .min_inner_size(320.0, 160.0)
    .decorations(false)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .transparent(true)
    .shadow(false)
    .resizable(true)
    .focused(false)
    .accept_first_mouse(true)
    .visible(false)
    .build()
    .map_err(|e| format!("创建桌面歌词窗口失败: {e}"))?;

    win.set_ignore_cursor_events(false)
        .map_err(|e| format!("设置桌面歌词鼠标事件失败: {e}"))?;
    #[cfg(target_os = "macos")]
    {
        // 必须在窗口第一次上屏之前设好层级与跨空间行为，
        // 否则 WindowServer 已经按普通窗口把它分好空间了。
        win.set_visible_on_all_workspaces(true)
            .map_err(|e| format!("设置桌面歌词跨桌面显示失败: {e}"))?;
        elevate_lyric_window_over_fullscreen(app, &win)?;
    }
    #[cfg(not(target_os = "macos"))]
    win.center()
        .map_err(|e| format!("居中桌面歌词失败: {e}"))?;
    win.show()
        .map_err(|e| format!("显示桌面歌词失败: {e}"))?;
    #[cfg(target_os = "macos")]
    {
        place_lyric_on_secondary_display(app, &win)?;
        start_lyric_window_keeper(app);
    }
    Ok(win)
}

#[tauri::command]
fn open_desktop_lyric(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("lyric") {
        win.set_ignore_cursor_events(false)
            .map_err(|e| format!("设置桌面歌词鼠标事件失败: {e}"))?;
        // macOS 的置顶 / 跨桌面交给 elevate_lyric_window_over_fullscreen（要盖住全屏应用）
        #[cfg(not(target_os = "macos"))]
        win.set_always_on_top(true)
            .map_err(|e| format!("设置桌面歌词置顶失败: {e}"))?;
        if win.is_minimized().unwrap_or(false) {
            let _ = win.unminimize();
        }
        win.show()
            .map_err(|e| format!("显示桌面歌词失败: {e}"))?;
        #[cfg(target_os = "macos")]
        {
            elevate_lyric_window_over_fullscreen(&app, &win)?;
            start_lyric_window_keeper(&app);
        }
        let _ = win.emit("desktop-lyric:cmd", "unlock");
        return Ok(());
    }

    create_lyric_window(&app)?;
    Ok(())
}

// ---------- Chrome 扩展用的本地歌词悬浮层接口 ----------

/// 前端推送过来的播放信息（歌词原文 + 进度）
#[derive(serde::Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct LyricOverlayInput {
    lyric_text: String,
    tlyric_text: String,
    current_time: f64,
    playing: bool,
    title: String,
    artist: String,
}

/// 本地 HTTP 接口返回给 Chrome 扩展的内容
#[derive(serde::Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct LyricOverlayOutput {
    visible: bool,
    line: String,
    next: String,
    translation: String,
    title: String,
    artist: String,
    playing: bool,
}

struct LyricOverlayState(std::sync::Arc<std::sync::Mutex<LyricOverlayOutput>>);

/// 解析 LRC 时间标签（[mm:ss.xx] / [mm:ss]）
fn parse_lrc_seconds(tag: &str) -> Option<f64> {
    let (mm, rest) = tag.split_once(':')?;
    if rest.contains(':') {
        return None;
    }
    let minutes: f64 = mm.trim().parse().ok()?;
    let seconds: f64 = rest.trim().parse().ok()?;
    Some(minutes * 60.0 + seconds)
}

fn parse_lrc_lines(text: &str) -> Vec<(f64, String)> {
    let mut out: Vec<(f64, String)> = Vec::new();
    for raw in text.lines() {
        let mut rest = raw.trim();
        let mut times: Vec<f64> = Vec::new();
        while let Some(stripped) = rest.strip_prefix('[') {
            let Some(end) = stripped.find(']') else { break };
            let Some(seconds) = parse_lrc_seconds(&stripped[..end]) else { break };
            times.push(seconds);
            rest = stripped[end + 1..].trim_start();
        }
        let content = rest.trim();
        if content.is_empty() || times.is_empty() {
            continue;
        }
        for seconds in times {
            out.push((seconds, content.to_string()));
        }
    }
    out.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    out
}

/// 返回（当前行，下一行）
fn lyric_lines_at(lines: &[(f64, String)], position: f64) -> (String, String) {
    let index = lines.iter().rposition(|(start, _)| *start <= position + 0.2);
    match index {
        Some(i) => (
            lines[i].1.clone(),
            lines.get(i + 1).map(|l| l.1.clone()).unwrap_or_default(),
        ),
        None => (
            String::new(),
            lines.first().map(|l| l.1.clone()).unwrap_or_default(),
        ),
    }
}

#[tauri::command]
fn update_lyric_overlay(
    state: tauri::State<LyricOverlayState>,
    input: LyricOverlayInput,
) -> Result<(), String> {
    let lines = parse_lrc_lines(&input.lyric_text);
    let translations = parse_lrc_lines(&input.tlyric_text);
    let (line, next) = lyric_lines_at(&lines, input.current_time);
    let (translation, _) = lyric_lines_at(&translations, input.current_time);
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    *guard = LyricOverlayOutput {
        visible: !line.is_empty() || !next.is_empty(),
        line,
        next,
        translation,
        title: input.title,
        artist: input.artist,
        playing: input.playing,
    };
    Ok(())
}

/// 只监听回环地址，给 Chrome 扩展读当前歌词
fn spawn_lyric_overlay_server(state: std::sync::Arc<std::sync::Mutex<LyricOverlayOutput>>) {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    std::thread::spawn(move || {
        let listener = [39517u16, 39518, 39519]
            .iter()
            .find_map(|port| TcpListener::bind(("127.0.0.1", *port)).ok());
        let Some(listener) = listener else {
            return;
        };
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut buffer = [0u8; 2048];
            let _ = stream.read(&mut buffer);
            let body = state
                .lock()
                .map(|guard| serde_json::to_string(&*guard).unwrap_or_else(|_| "{}".into()))
                .unwrap_or_else(|_| "{}".into());
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.as_bytes().len(),
                body
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            open_desktop_lyric,
            update_lyric_overlay,
            proxy_api,
            download_file,
            get_audio_cache_dir,
            find_cached_audio,
            cache_audio_file,
            get_audio_cache_stats,
            clear_audio_cache
        ])
        .setup(|app| {
            // 允许 WebView 通过 asset 协议播放 cache_dir 内文件
            if let Ok(dir) = audio_cache_dir() {
                let _ = app.asset_protocol_scope().allow_directory(&dir, true);
            }

            // 给 Chrome 扩展提供当前歌词（只绑定 127.0.0.1）
            let overlay_state = std::sync::Arc::new(std::sync::Mutex::new(
                LyricOverlayOutput::default(),
            ));
            app.manage(LyricOverlayState(overlay_state.clone()));
            spawn_lyric_overlay_server(overlay_state);

            // 强制设置主窗口/任务栏图标（避免仅依赖 exe 资源或系统图标缓存）
            if let Some(icon) = app.default_window_icon().cloned() {
                for (_label, win) in app.webview_windows() {
                    let _ = win.set_icon(icon.clone());
                }
            }

            let show_i = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
            let play_i = MenuItem::with_id(app, "toggle", "播放 / 暂停", true, None::<&str>)?;
            let prev_i = MenuItem::with_id(app, "prev", "上一首", true, None::<&str>)?;
            let next_i = MenuItem::with_id(app, "next", "下一首", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

            let menu = Menu::with_items(app, &[&show_i, &play_i, &prev_i, &next_i, &quit_i])?;

            let tray_icon = app
                .default_window_icon()
                .cloned()
                .expect("app icon missing; run `pnpm tauri icon`");
            let _tray = TrayIconBuilder::new()
                .icon(tray_icon)
                .menu(&menu)
                .tooltip("Music Desktop")
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.unminimize();
                            let _ = win.set_focus();
                        }
                    }
                    "toggle" => {
                        let _ = app.emit("player:cmd", "toggle");
                    }
                    "prev" => {
                        let _ = app.emit("player:cmd", "prev");
                    }
                    "next" => {
                        let _ = app.emit("player:cmd", "next");
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(win) = app.get_webview_window("main") {
                            if win.is_visible().unwrap_or(false) {
                                let _ = win.hide();
                            } else {
                                let _ = win.show();
                                let _ = win.unminimize();
                                let _ = win.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
