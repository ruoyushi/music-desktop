// 歌词悬浮层：把歌词画成当前网页的一个元素。
// 它是网页自身的一部分，所以浏览器全屏（macOS 全屏空间）时也不会被别的窗口盖住。
(() => {
  const HOST_ID = "md-lyric-overlay";
  const POLL_MS = 400;
  if (document.getElementById(HOST_ID)) return;

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText = [
    "position:fixed",
    "left:0",
    "right:0",
    "bottom:6vh",
    "z-index:2147483647",
    "pointer-events:none",
    "display:none",
  ].join(";");

  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    .box {
      box-sizing: border-box;
      padding: 0 4vw;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.35em;
      text-align: center;
      /* 暖米色：比纯白柔和，长时间看更舒服 */
      color: #f0e6d2;
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC",
        "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    }
    .line {
      font-size: clamp(26px, 3.2vw, 56px);
      font-weight: 700;
      line-height: 1.25;
      white-space: pre-wrap;
      text-shadow: 0 2px 10px rgba(0, 0, 0, 0.9), 0 0 3px rgba(0, 0, 0, 0.95),
        0 0 26px rgba(0, 0, 0, 0.6);
    }
    .trans {
      font-size: clamp(18px, 1.9vw, 34px);
      line-height: 1.3;
      white-space: pre-wrap;
      opacity: 0.9;
      text-shadow: 0 2px 8px rgba(0, 0, 0, 0.9);
    }
    .next {
      font-size: clamp(15px, 1.4vw, 26px);
      line-height: 1.3;
      white-space: pre-wrap;
      opacity: 0.6;
      text-shadow: 0 2px 8px rgba(0, 0, 0, 0.85);
    }
  `;

  const box = document.createElement("div");
  box.className = "box";
  const lineEl = document.createElement("div");
  lineEl.className = "line";
  const transEl = document.createElement("div");
  transEl.className = "trans";
  const nextEl = document.createElement("div");
  nextEl.className = "next";
  box.append(lineEl, transEl, nextEl);
  shadow.append(style, box);

  // 网页用 HTML5 全屏（视频全屏）时，只有全屏元素里的内容会被渲染，
  // 所以要跟着挪进全屏元素里；<video> 不能有子节点，保持不动即可。
  function parentTarget() {
    const fs = document.fullscreenElement || document.webkitFullscreenElement;
    if (fs && fs !== host && fs.tagName !== "VIDEO" && fs.appendChild) return fs;
    return document.documentElement || document.body;
  }

  function mount() {
    const parent = parentTarget();
    if (!parent) return;
    if (host.parentNode !== parent) parent.appendChild(host);
    host.style.position = "fixed";
    host.style.zIndex = "2147483647";
    host.style.pointerEvents = "none";
  }

  mount();
  document.addEventListener("fullscreenchange", mount, true);
  document.addEventListener("webkitfullscreenchange", mount, true);

  let lastKey = null;

  // 同一个标签页里可以临时关掉歌词：Alt+Shift+L
  const OFF_KEY = "md-lyric-off";
  function readOffFlag() {
    try {
      return sessionStorage.getItem(OFF_KEY) === "1";
    } catch {
      return false;
    }
  }

  function writeOffFlag(off) {
    try {
      sessionStorage.setItem(OFF_KEY, off ? "1" : "0");
    } catch {
      // 部分页面禁用存储，忽略即可
    }
  }

  let enabled = !readOffFlag();

  window.addEventListener(
    "keydown",
    (event) => {
      if (!event.altKey || !event.shiftKey) return;
      if (event.key !== "L" && event.key !== "l") return;
      enabled = !enabled;
      writeOffFlag(!enabled);
      event.preventDefault();
      event.stopPropagation();
      if (!enabled) render(null);
    },
    true,
  );

  function render(data) {
    if (!host.isConnected) mount();

    // 暂停 / 停止播放时不显示（playing=false）
    const visible = !!(data && data.visible && data.playing && (data.line || data.next));
    if (!visible) {
      if (lastKey !== null) {
        host.style.display = "none";
        lastKey = null;
      }
      return;
    }

    const key = `${data.line}\u0001${data.translation}\u0001${data.next}`;
    if (key !== lastKey) {
      lastKey = key;
      lineEl.textContent = data.line || "";
      transEl.textContent = data.translation || "";
      nextEl.textContent = data.next || "";
      transEl.style.display = data.translation ? "block" : "none";
      nextEl.style.display = data.next ? "block" : "none";
    }
    host.style.display = "block";
  }

  async function tick() {
    // 后台没开（Music Desktop 没在播放 / 没启动）时接口会失败，这里静默隐藏
    if (document.visibilityState !== "visible") return;
    if (!enabled) return;
    let res = null;
    try {
      res = await chrome.runtime.sendMessage({ type: "md-lyric-poll" });
    } catch {
      // 扩展被重新加载时上下文会失效，忽略即可
      return;
    }
    render(res && res.ok ? res.data : null);
  }

  setInterval(tick, POLL_MS);
  tick();
})();
