// 从本机 Music Desktop 的歌词接口读取当前歌词。
// 放在扩展后台里请求，既不受网页 https 的混合内容限制，也不受网页跨域限制。
const PORTS = [39517, 39518, 39519];
const TIMEOUT_MS = 800;

// 歌词显示设置（在扩展图标弹窗里改），默认只在副屏显示
const DEFAULT_SETTINGS = { enabled: true, scope: "secondary" };
const CACHE_MS = 1000;

let activePort = null;

async function probe(port) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function poll() {
  const order = activePort
    ? [activePort, ...PORTS.filter((p) => p !== activePort)]
    : PORTS;
  for (const port of order) {
    try {
      const data = await probe(port);
      activePort = port;
      return { ok: true, data };
    } catch {
      if (activePort === port) activePort = null;
    }
  }
  return { ok: false };
}

async function getSettings() {
  try {
    const saved = await chrome.storage.local.get(DEFAULT_SETTINGS);
    return {
      enabled: saved.enabled !== false,
      scope: typeof saved.scope === "string" ? saved.scope : DEFAULT_SETTINGS.scope,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

// ---- 屏幕信息（判断某个浏览器窗口在哪块屏幕上）----

let displaysCache = { at: 0, list: [] };

async function getDisplays() {
  const now = Date.now();
  if (now - displaysCache.at < CACHE_MS) return displaysCache.list;
  let list = [];
  try {
    list = await chrome.system.display.getInfo();
  } catch {
    list = [];
  }
  displaysCache = { at: now, list };
  return list;
}

function overlapArea(a, b) {
  const width = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const height = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return width > 0 && height > 0 ? width * height : 0;
}

// 窗口和哪块屏幕重叠最多，就认为它在那块屏幕上
function bestDisplayForBounds(bounds, displays) {
  if (!bounds || !bounds.width || !displays.length) return null;
  let best = null;
  let bestArea = 0;
  for (const display of displays) {
    const area = overlapArea(bounds, display.bounds);
    if (area > bestArea) {
      bestArea = area;
      best = display;
    }
  }
  if (best) return best;
  const centerX = bounds.left + bounds.width / 2;
  const centerY = bounds.top + bounds.height / 2;
  for (const display of displays) {
    const b = display.bounds;
    if (
      centerX >= b.left &&
      centerX < b.left + b.width &&
      centerY >= b.top &&
      centerY < b.top + b.height
    ) {
      return display;
    }
  }
  return null;
}

const windowDisplayCache = new Map();

async function displayForWindow(windowId) {
  if (windowId == null) return null;
  const now = Date.now();
  const cached = windowDisplayCache.get(windowId);
  if (cached && now - cached.at < CACHE_MS) return cached.display;

  const displays = await getDisplays();
  if (!displays.length) return null;

  let win = null;
  try {
    win = await chrome.windows.get(windowId);
  } catch {
    return null;
  }
  const display = bestDisplayForBounds(win, displays);
  windowDisplayCache.set(windowId, { at: now, display });
  return display;
}

function isAllowedOnDisplay(scope, display) {
  if (scope === "all") return true;
  if (!display) return true; // 认不出窗口在哪块屏幕时不拦截，宁可多显示
  if (scope.startsWith("display:")) {
    return String(display.id) === scope.slice("display:".length);
  }
  return !display.isPrimary; // scope === "secondary"
}

async function isAllowedForWindow(scope, windowId) {
  if (scope === "all") return true;
  const displays = await getDisplays();
  if (!displays.length) return true; // 拿不到屏幕信息时不拦截，避免歌词整个消失

  if (scope.startsWith("display:")) {
    const wanted = scope.slice("display:".length);
    const stillConnected = displays.some((d) => String(d.id) === wanted);
    // 选中的屏幕被拔掉之后，退回「只在副屏显示」的行为
    if (!stillConnected) return isAllowedForWindow("secondary", windowId);
  }

  return isAllowedOnDisplay(scope, await displayForWindow(windowId));
}

async function lyricResponse(sender) {
  const settings = await getSettings();
  if (!settings.enabled) return { ok: true, data: null, allowed: false };

  const windowId = sender && sender.tab ? sender.tab.windowId : null;
  const allowed = await isAllowedForWindow(settings.scope, windowId);
  if (!allowed) return { ok: true, data: null, allowed: false };

  const result = await poll();
  return { ...result, allowed: true };
}

// 弹窗用：当前窗口在哪块屏幕上 + 现在接着哪几块屏幕
async function displayReport(bounds) {
  displaysCache = { at: 0, list: [] };
  const displays = await getDisplays();
  let current = bounds ? bestDisplayForBounds(bounds, displays) : null;
  if (!current) current = displays.find((d) => d.isPrimary) || displays[0] || null;

  return {
    displays: displays.map((d) => ({
      id: String(d.id),
      name: d.name || "",
      isPrimary: !!d.isPrimary,
    })),
    current: current
      ? { id: String(current.id), name: current.name || "", isPrimary: !!current.isPrimary }
      : null,
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return;
  if (message.type === "md-lyric-poll") {
    lyricResponse(sender).then(
      sendResponse,
      () => sendResponse({ ok: false, allowed: true }),
    );
    return true;
  }
  if (message.type === "md-display-at") {
    displayReport(message.bounds).then(sendResponse, () => sendResponse(null));
    return true;
  }
});
