// 从本机 Music Desktop 的歌词接口读取当前歌词。
// 放在扩展后台里请求，既不受网页 https 的混合内容限制，也不受网页跨域限制。
const PORTS = [39517, 39518, 39519];
const TIMEOUT_MS = 800;

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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "md-lyric-poll") return;
  poll().then(sendResponse, () => sendResponse({ ok: false }));
  return true;
});
