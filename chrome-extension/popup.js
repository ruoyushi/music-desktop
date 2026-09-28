// 扩展图标弹窗：歌词总开关 + 歌词显示在哪些屏幕。
const enabledEl = document.getElementById("enabled");
const scopeEls = Array.from(document.querySelectorAll('input[name="scope"]'));
const hereEl = document.getElementById("scope-here");
const hereTextEl = document.getElementById("here-text");
const hereOptEl = document.getElementById("opt-here");
const statusEl = document.getElementById("status");

let report = null; // 后台返回的屏幕信息
let currentDisplayId = null; // 弹窗所在窗口的屏幕
let storedDisplayId = null; // 「只在这块屏幕」已保存的屏幕

function displayName(display) {
  return display.isPrimary ? "主屏" : "副屏";
}

function checkScope(value) {
  const el = scopeEls.find((item) => item.value === value);
  if (el) el.checked = true;
}

function checkedScope() {
  const checked = scopeEls.find((el) => el.checked);
  if (!checked || checked.value === "secondary") return "secondary";
  if (checked.value === "all") return "all";
  return storedDisplayId ? `display:${storedDisplayId}` : "secondary";
}

// 弹窗本身不是浏览器窗口，用当前活动标签页反推它所在的窗口
async function currentBrowserWindow() {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
      windowType: "normal",
    });
    if (tab && tab.windowId != null) return await chrome.windows.get(tab.windowId);
  } catch {
    // 忽略，继续用下面的兜底方式
  }
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    if (win && win.id != null) return win;
  } catch {
    // 忽略
  }
  try {
    return await chrome.windows.getCurrent();
  } catch {
    return null;
  }
}

function refreshStatus() {
  const displays = (report && report.displays) || [];
  const current = report ? report.current : null;
  if (!displays.length) {
    statusEl.textContent = "没读到屏幕信息，歌词暂时不做屏幕限制";
    return;
  }

  const lines = [
    `${current ? `当前窗口在${displayName(current)}` : "未识别当前窗口位置"} · 已连接 ${displays.length} 块屏幕`,
  ];

  const scope = checkedScope();
  if (scope.startsWith("display:")) {
    const saved = displays.find((d) => d.id === scope.slice("display:".length));
    if (saved) lines.push(`只显示在：${displayName(saved)}`);
    else lines.push("已选屏幕当前未连接，会按副屏处理");
  } else if (scope === "secondary" && displays.length === 1) {
    lines.push("只有一块屏幕时，请选「所有屏幕都显示」");
  }

  statusEl.textContent = lines.join("\n");
}

async function init() {
  const [saved, win] = await Promise.all([
    chrome.storage.local.get({ enabled: true, scope: "secondary" }),
    currentBrowserWindow(),
  ]);

  enabledEl.checked = saved.enabled !== false;

  if (win && win.width) {
    try {
      report = await chrome.runtime.sendMessage({
        type: "md-display-at",
        bounds: { left: win.left, top: win.top, width: win.width, height: win.height },
      });
    } catch {
      report = null;
    }
  }

  const displays = (report && report.displays) || [];
  const current = report ? report.current : null;
  currentDisplayId = current ? current.id : null;

  const scope = saved.scope || "secondary";
  if (scope === "all") {
    checkScope("all");
  } else if (scope.startsWith("display:")) {
    storedDisplayId = scope.slice("display:".length);
    checkScope("here");
  } else {
    checkScope("secondary");
  }

  const labelDisplay =
    (storedDisplayId && displays.find((d) => d.id === storedDisplayId)) || current;
  if (labelDisplay) hereTextEl.textContent = `只在这块屏幕（${displayName(labelDisplay)}）`;

  if (!currentDisplayId) {
    hereEl.disabled = true;
    hereOptEl.dataset.disabled = "true";
  }

  refreshStatus();
}

enabledEl.addEventListener("change", () => {
  chrome.storage.local.set({ enabled: enabledEl.checked });
});

for (const el of scopeEls) {
  el.addEventListener("change", () => {
    if (!el.checked || el.value === "here") return;
    chrome.storage.local.set({ scope: el.value === "all" ? "all" : "secondary" });
    refreshStatus();
  });
}

// 再点一次已选中的「只在这块屏幕」会改成当前窗口所在的屏幕
hereEl.addEventListener("click", () => {
  if (!currentDisplayId) return;
  storedDisplayId = currentDisplayId;
  chrome.storage.local.set({ scope: `display:${currentDisplayId}` });
  const current = report ? report.current : null;
  if (current) hereTextEl.textContent = `只在这块屏幕（${displayName(current)}）`;
  refreshStatus();
});

init();
