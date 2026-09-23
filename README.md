# Music Desktop

感谢[GD音乐台(https://music.gdstudio.xyz)](https://music.gdstudio.xyz) 提供的 API，主要解决网页版必须常开浏览器，不支持系统托盘与桌面歌词/迷你窗的问题

基于 **Tauri 2 + Vue 3 + Naive UI** 的桌面端在线音乐播放器。

对接 [GD Studio Music API](https://music-api.gdstudio.xyz/api.php)，提供搜索、在线播放、歌词、播放队列，以及系统托盘与桌面歌词/迷你窗，避免网页版必须常开浏览器的问题。

> **免责声明**：音源 API 仅供学习研究，禁止商用（CC BY-NC 4.0）。本项目不提供任何破解或付费内容，资源来自网络，仅限本人学习参考，严禁下载、传播或商用，如侵权请与我联系删除。继续使用将视为同意本声明

## 功能

- 多音源搜索（默认网易云，可切换）
- 播放 / 暂停 / 上一首 / 下一首 / 进度 / 音量
- 播放队列、循环模式
- LRC 歌词同步
- 关闭到系统托盘、托盘菜单控制
- 迷你播放器、桌面歌词悬浮窗
- 无需登录
- 单曲下载（可选音质，另存为本地文件）
- **多套主题皮肤**（含丰富亮色），独立主题窗口切换；标题栏调色盘入口
- **在线更新**（GitHub Releases + Tauri Updater，无需自建服务器）
- **音频本地缓存**（安装目录 `cache_dir/audio`，播过后再次播放走本地）

## 本仓库补充：macOS 桌面歌词
本仓库基于 [hsg965/music-desktop](https://github.com/hsg965/music-desktop) 修改，主要补充 macOS 上的歌词显示能力：

- macOS 原生悬浮歌词窗：歌词窗口在 Rust 侧创建，支持置顶、跨桌面显示、未激活时首次点击可用
- **网页内歌词浮层**：应用在本机 `127.0.0.1:39517` 提供当前歌词 JSON（端口占用时自动顺延到 39518/39519），配套 Chrome 扩展在任意网页的最上层渲染歌词；浏览器全屏（含 macOS 全屏空间）时同样可见，`Alt+Shift+L` 可按标签页开关
- 扩展安装与使用说明见 [`chrome-extension/README.md`](chrome-extension/README.md)

歌词数据由 Music Desktop 提供，因此需要先在应用里播放歌曲；扩展装好后请重新加载一次网页。

## 技术栈

- Tauri 2 / Rust
- Vue 3 + TypeScript + Vite
- Pinia / Vue Router
- Naive UI + UnoCSS
- `@iconify/vue`（Remix Icon）

## 开发

前置：Node.js、pnpm、Rust（Windows 还需 WebView2）。

```bash
cd music-desktop
pnpm install
pnpm tauri dev
```

仅前端预览（无托盘/多窗口）：

```bash
pnpm dev
```

## 打包

### 本地打包

```bash
pnpm tauri build
# 或
pnpm tauri:build
```

产物在 `src-tauri/target/release/bundle/`。

macOS 透明桌面歌词需要启用 Tauri 的 `macOSPrivateApi`。仓库已经开启，并将歌词窗口放在 Rust 侧创建，以支持所有桌面可见和未激活时首次点击可用：

```bash
pnpm tauri build --bundles app --no-sign
```

生成的 `.app` 位于 `src-tauri/target/release/bundle/macos/`。

### GitHub Actions 自动发布（Windows + macOS）

仓库已配置 [`.github/workflows/release.yml`](.github/workflows/release.yml)：

1. **上传代码到 GitHub**（开启 Actions 权限；仓库建议 **Public**，否则客户端无法匿名下载更新包）
2. **配置更新签名 Secrets**（见下方「在线更新」）
3. **改版本号**（两处保持一致）：
   - `package.json` → `"version"`
   - `src-tauri/tauri.conf.json` → `"version"`
   - （可选）`src-tauri/Cargo.toml` → `version`
4. **打标签并推送到 GitHub**（触发 Actions）：

```bash
git add .
git commit -m "release: v0.1.0"
git tag v0.1.0
git push github main
git push github v0.1.0
```

5. 打开仓库 **Actions** 查看 `Release` 工作流
6. 构建完成后到 **Releases** 下载：
   - Windows：`.exe`（NSIS；以及 updater 用的 `.nsis.zip` / `.sig`）
   - macOS Apple Silicon：`aarch64` 的 `.dmg` / `.app.tar.gz`
   - 清单：`latest.json`（客户端自动更新读取）

也可在 **Actions → Release → Run workflow** 手动触发（可勾选草稿 Release）。

> 首次使用请确认：仓库 **Settings → Actions → General** 中允许读写权限（Workflow permissions → Read and write）。

### 在线更新（无需自建服务器）

应用使用 [Tauri Updater](https://v2.tauri.app/plugin/updater/)，从 **GitHub Releases** 拉取 `latest.json` 与签名安装包：

- 设置页 → **检查更新**
- 启动约 4 秒后 **静默检查**（仅有新版本时弹窗）
- 更新失败可打开 **GitHub Releases** 手动下载

#### 一次性：签名密钥与 Secrets

本机已生成过密钥时，私钥在 `src-tauri/.tauri-keys/`（该目录已 gitignore，**切勿提交**）。

若需重新生成：

```bash
pnpm tauri signer generate -w src-tauri/.tauri-keys/music-desktop.key -p "你的密码" --ci -f
```

1. 将 **公钥** 内容写入 `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`（与 `.key.pub` 一致）
2. 在 GitHub 仓库 **Settings → Secrets and variables → Actions** 新增：
   - `TAURI_SIGNING_PRIVATE_KEY`：私钥文件 **全文**（`music-desktop.key` 内容）
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：生成密钥时的密码（无密码可留空或不设）
3. 打 tag 发布后，Release 中应出现 `latest.json` 与 `.sig` 文件

> **重要**：私钥或密码丢失后，旧客户端将无法校验新包签名，只能让用户重装并更换公钥。请备份私钥。

#### 本地带签名打包（可选）

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw src-tauri/.tauri-keys/music-desktop.key
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "你的密码"
pnpm tauri build
```

## API

基址：`https://music-api.gdstudio.xyz/api.php`

| types  | 说明     |
|--------|----------|
| search | 搜索     |
| url    | 播放地址 |
| pic    | 封面     |
| lyric  | 歌词     |

## 快捷键（主窗口）

| 按键 | 功能 |
|------|------|
| `Space` | 播放 / 暂停 |
| `Ctrl + ←` | 上一首 |
| `Ctrl + →` | 下一首 |

## License

本仓库代码可按需使用；第三方 API 遵循其自身协议。
