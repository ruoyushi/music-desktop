import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { fetchLyric, fetchPicUrl, fetchPlayUrl } from "../api/music";
import type { PlayMode, PlayerSnapshot, Track } from "../types/music";
import {
  cacheRemoteAudio,
  findCachedAudioPath,
  isRemoteMediaUrl,
  toPlayableSrc,
} from "../utils/audioCache";
import { useSettingsStore } from "./settings";

const QUEUE_KEY = "music-desktop-queue";

/** 后台缓存进行中，避免同一首歌重复下载 */
const cachingKeys = new Set<string>();

function loadQueue(): Track[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

let audio: HTMLAudioElement | null = null;
let broadcastTimer: number | null = null;
/** 切歌会话 id：快速连点上下曲时丢弃过期的加载/播放结果 */
let playSessionId = 0;

function getAudio(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio();
    audio.preload = "auto";
  }
  return audio;
}

export const usePlayerStore = defineStore("player", () => {
  const settings = useSettingsStore();

  const queue = ref<Track[]>(loadQueue());
  const currentIndex = ref(-1);
  const playing = ref(false);
  const currentTime = ref(0);
  const duration = ref(0);
  const mode = ref<PlayMode>("list");
  const loading = ref(false);
  const error = ref("");
  const lyricText = ref("");
  const tlyricText = ref("");
  /** 随机模式下的上一首历史（索引），用于 prev 回退 */
  const shuffleHistory: number[] = [];

  const currentTrack = computed(() =>
    currentIndex.value >= 0 ? queue.value[currentIndex.value] ?? null : null,
  );

  function saveQueue() {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.value));
  }

  watch(queue, saveQueue, { deep: true });

  function bindAudioEvents() {
    const el = getAudio();
    el.volume = settings.volume;

    el.ontimeupdate = () => {
      currentTime.value = el.currentTime;
      scheduleBroadcast();
    };
    el.onloadedmetadata = () => {
      duration.value = el.duration || 0;
    };
    el.onplay = () => {
      playing.value = true;
      broadcastState();
    };
    el.onpause = () => {
      playing.value = false;
      broadcastState();
    };
    el.onended = () => {
      onEnded();
    };
    el.onerror = () => {
      error.value = "播放失败，可能链接已失效或音源不可用";
      playing.value = false;
      broadcastState();
    };
  }

  bindAudioEvents();

  function snapshot(): PlayerSnapshot {
    return {
      track: currentTrack.value,
      playing: playing.value,
      currentTime: currentTime.value,
      duration: duration.value,
      volume: settings.volume,
      mode: mode.value,
      queue: queue.value,
      currentIndex: currentIndex.value,
      lyricText: lyricText.value,
      tlyricText: tlyricText.value,
    };
  }

  async function broadcastState() {
    try {
      const { emit } = await import("@tauri-apps/api/event");
      await emit("player:state", snapshot());
      // 同步给本机歌词接口（Chrome 页面内的悬浮歌词用）
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("update_lyric_overlay", {
        input: {
          lyricText: lyricText.value,
          tlyricText: tlyricText.value,
          currentTime: currentTime.value,
          playing: playing.value,
          title: currentTrack.value?.name ?? "",
          artist: (currentTrack.value?.artist ?? []).join(", "),
        },
      });
    } catch {
      // 浏览器预览时忽略
    }
  }

  function scheduleBroadcast() {
    if (broadcastTimer != null) return;
    // 桌面歌词跟唱需要较及时的进度
    broadcastTimer = window.setTimeout(() => {
      broadcastTimer = null;
      broadcastState();
    }, 80);
  }

  function scheduleCacheRemote(
    track: Track,
    br: number,
    remoteUrl: string,
  ) {
    const key = `${track.source}-${track.id}-${br}`;
    if (!isRemoteMediaUrl(remoteUrl) || cachingKeys.has(key)) return;
    cachingKeys.add(key);
    // 延后一点再下，避免和首播抢带宽；失败会在控制台打 [audio-cache]
    window.setTimeout(() => {
      void cacheRemoteAudio(track.source, track.id, br, remoteUrl).finally(() => {
        cachingKeys.delete(key);
      });
    }, 800);
  }

  /**
   * 解析可播放地址。封面/歌词在后台并行补齐，不阻塞起播。
   * @returns playUrl 成功时返回地址，失败返回 null
   */
  async function resolvePlayUrl(
    track: Track,
    sessionId: number,
  ): Promise<string | null> {
    error.value = "";
    try {
      const br = settings.bitrate;

      // 1) 优先使用安装目录 cache_dir 中的本地音频
      const cachedPath = await findCachedAudioPath(track.source, track.id, br);
      if (sessionId !== playSessionId) return null;

      let playUrl: string | null = null;
      let remoteForCache: string | null = null;

      if (cachedPath) {
        playUrl = await toPlayableSrc(cachedPath);
      } else {
        // 2) 远程：队列里已有 http(s) 链则复用，否则请求 API
        const existingRemote = isRemoteMediaUrl(track.url) ? track.url! : null;
        const urlRes = existingRemote
          ? { url: existingRemote }
          : await fetchPlayUrl(track.id, track.source, br);
        if (sessionId !== playSessionId) return null;
        if (!urlRes?.url) {
          error.value = "无法获取播放地址（可能无版权或音源不可用）";
          return null;
        }
        // 协议相对 //cdn... → https://cdn...
        const remote = urlRes.url.startsWith("//")
          ? `https:${urlRes.url}`
          : urlRes.url;
        playUrl = remote;
        remoteForCache = remote;
      }

      if (!playUrl) {
        error.value = "无法获取播放地址（可能无版权或音源不可用）";
        return null;
      }

      track.url = playUrl;

      // 3) 首次在线播放：后台写入 cache_dir，下次直接本地播
      if (remoteForCache) {
        scheduleCacheRemote(track, br, remoteForCache);
      }

      // 封面 / 歌词后台补齐，不挡住起播
      void fillTrackMeta(track, sessionId);

      return playUrl;
    } catch (e) {
      if (sessionId !== playSessionId) return null;
      error.value = e instanceof Error ? e.message : "加载失败";
      return null;
    }
  }

  /** 封面与歌词异步填充；若已切到别的歌则丢弃结果 */
  async function fillTrackMeta(track: Track, sessionId: number) {
    try {
      const [pic, lyric] = await Promise.all([
        track.picUrl
          ? Promise.resolve(track.picUrl)
          : fetchPicUrl(track.pic_id, track.source, 500),
        fetchLyric(track.lyric_id, track.source),
      ]);
      if (sessionId !== playSessionId) return;
      if (pic) track.picUrl = pic;
      lyricText.value = lyric.lyric || "";
      tlyricText.value = lyric.tlyric || "";
      broadcastState();
    } catch {
      // 元数据失败不影响播放
    }
  }

  /**
   * 先切换当前曲目（UI 立刻更新），再加载音源并播放。
   * 快速连点时以最新一次为准。
   */
  async function playAt(index: number) {
    if (index < 0 || index >= queue.value.length) return;

    const sessionId = ++playSessionId;
    const track = queue.value[index];

    // —— 1) 先切换：立刻更新队列指针与 UI 状态 ——
    currentIndex.value = index;
    currentTime.value = 0;
    duration.value = 0;
    lyricText.value = "";
    tlyricText.value = "";
    error.value = "";
    loading.value = true;
    playing.value = false;

    const el = getAudio();
    el.pause();
    el.removeAttribute("src");
    el.load();
    broadcastState();

    // —— 2) 再加载音源 ——
    const playUrl = await resolvePlayUrl(track, sessionId);
    if (sessionId !== playSessionId) return;

    if (!playUrl) {
      loading.value = false;
      playing.value = false;
      broadcastState();
      return;
    }

    // —— 3) 起播 ——
    el.src = playUrl;
    el.volume = settings.volume;
    try {
      await el.play();
      if (sessionId !== playSessionId) return;
      playing.value = true;
    } catch {
      if (sessionId !== playSessionId) return;
      error.value = "自动播放被拦截，请点击播放";
      playing.value = false;
    } finally {
      if (sessionId === playSessionId) {
        loading.value = false;
      }
    }
    broadcastState();
  }

  async function playTrack(track: Track, replaceQueue = false) {
    if (replaceQueue) {
      queue.value = [track];
      await playAt(0);
      return;
    }

    const key = `${track.source}-${track.id}`;
    let idx = queue.value.findIndex(
      (t) => `${t.source}-${t.id}` === key,
    );
    if (idx < 0) {
      queue.value.push({ ...track });
      idx = queue.value.length - 1;
    }
    await playAt(idx);
  }

  /** 用列表替换队列并从第一首开始播（一键播放） */
  async function playAll(tracks: Track[], startIndex = 0) {
    if (!tracks.length) return;
    shuffleHistory.length = 0;
    queue.value = tracks.map((t) => ({ ...t }));
    const idx = Math.max(0, Math.min(startIndex, queue.value.length - 1));
    await playAt(idx);
  }

  function addToQueue(track: Track) {
    const key = `${track.source}-${track.id}`;
    if (queue.value.some((t) => `${t.source}-${t.id}` === key)) return;
    queue.value.push({ ...track });
  }

  function addManyToQueue(tracks: Track[]) {
    for (const t of tracks) addToQueue(t);
  }

  function removeFromQueue(index: number) {
    if (index < 0 || index >= queue.value.length) return;
    queue.value.splice(index, 1);
    shuffleHistory.length = 0;
    if (currentIndex.value === index) {
      stop();
      currentIndex.value = -1;
    } else if (currentIndex.value > index) {
      currentIndex.value -= 1;
    }
    broadcastState();
  }

  function clearQueue() {
    stop();
    queue.value = [];
    currentIndex.value = -1;
    shuffleHistory.length = 0;
    lyricText.value = "";
    tlyricText.value = "";
    broadcastState();
  }

  /** 在队列中随机选一首（尽量避开当前曲） */
  function pickShuffleIndex(): number {
    const n = queue.value.length;
    if (n <= 0) return -1;
    if (n === 1) return 0;
    let idx = Math.floor(Math.random() * n);
    let guard = 0;
    while (idx === currentIndex.value && guard++ < 24) {
      idx = Math.floor(Math.random() * n);
    }
    return idx;
  }

  async function toggle() {
    const el = getAudio();
    if (!currentTrack.value) return;
    if (playing.value) {
      el.pause();
    } else {
      if (!el.src && currentTrack.value) {
        await playAt(currentIndex.value);
        return;
      }
      try {
        await el.play();
      } catch {
        error.value = "播放失败";
      }
    }
  }

  function pause() {
    getAudio().pause();
  }

  function stop() {
    const el = getAudio();
    el.pause();
    el.removeAttribute("src");
    el.load();
    playing.value = false;
    currentTime.value = 0;
    duration.value = 0;
  }

  async function next() {
    if (!queue.value.length) return;
    if (mode.value === "single") {
      await playAt(currentIndex.value);
      return;
    }
    if (mode.value === "shuffle") {
      if (currentIndex.value >= 0) {
        shuffleHistory.push(currentIndex.value);
        if (shuffleHistory.length > 80) shuffleHistory.shift();
      }
      const idx = pickShuffleIndex();
      if (idx < 0) return;
      await playAt(idx);
      return;
    }
    const nextIdx = currentIndex.value + 1;
    if (nextIdx >= queue.value.length) {
      if (mode.value === "list") {
        await playAt(0);
      } else {
        playing.value = false;
        broadcastState();
      }
      return;
    }
    await playAt(nextIdx);
  }

  async function prev() {
    if (!queue.value.length) return;
    if (currentTime.value > 3) {
      seek(0);
      return;
    }
    if (mode.value === "shuffle") {
      while (shuffleHistory.length) {
        const idx = shuffleHistory.pop()!;
        if (idx >= 0 && idx < queue.value.length && idx !== currentIndex.value) {
          await playAt(idx);
          return;
        }
      }
      // 无历史则再随机一首
      const idx = pickShuffleIndex();
      if (idx < 0) return;
      await playAt(idx);
      return;
    }
    const prevIdx = currentIndex.value - 1;
    if (prevIdx < 0) {
      if (mode.value === "list") {
        await playAt(queue.value.length - 1);
      } else {
        seek(0);
      }
      return;
    }
    await playAt(prevIdx);
  }

  function seek(time: number) {
    const el = getAudio();
    el.currentTime = Math.max(0, Math.min(time, el.duration || time));
    currentTime.value = el.currentTime;
    broadcastState();
  }

  function setVolume(v: number) {
    const vol = Math.max(0, Math.min(1, v));
    settings.volume = vol;
    getAudio().volume = vol;
    broadcastState();
  }

  function setMode(m: PlayMode) {
    if (m !== "shuffle") shuffleHistory.length = 0;
    mode.value = m;
    broadcastState();
  }

  function cycleMode() {
    const order: PlayMode[] = ["list", "single", "order", "shuffle"];
    const i = order.indexOf(mode.value);
    setMode(order[(i + 1) % order.length] ?? "list");
  }

  async function onEnded() {
    if (mode.value === "single") {
      await playAt(currentIndex.value);
      return;
    }
    await next();
  }

  // 托盘 / 迷你窗控制
  async function setupRemoteControl() {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      await listen("player:cmd", async (event) => {
        const cmd = event.payload as string;
        if (cmd === "toggle") await toggle();
        else if (cmd === "next") await next();
        else if (cmd === "prev") await prev();
        else if (cmd === "pause") pause();
        else if (cmd === "play" && !playing.value) await toggle();
      });
      // 桌面歌词 / 迷你窗刚打开时主动补一次状态，避免错过推送
      await listen("player:state:request", () => broadcastState());
    } catch {
      // ignore
    }
  }

  return {
    queue,
    currentIndex,
    currentTrack,
    playing,
    currentTime,
    duration,
    mode,
    loading,
    error,
    lyricText,
    tlyricText,
    playTrack,
    playAll,
    playAt,
    addToQueue,
    addManyToQueue,
    removeFromQueue,
    clearQueue,
    toggle,
    pause,
    stop,
    next,
    prev,
    seek,
    setVolume,
    setMode,
    cycleMode,
    snapshot,
    broadcastState,
    setupRemoteControl,
  };
});
