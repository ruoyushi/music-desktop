import { ofetch } from "ofetch";
import type {
  Bitrate,
  ChartInfo,
  LyricResult,
  MusicSource,
  PicResult,
  PlaylistDetail,
  Track,
  UrlResult,
} from "../types/music";
import { cacheKey, cachedRequest } from "./rateLimit";

const BASE = "https://music.gdstudio.xyz/api.php";
// const BASE = "https://music-api.gdstudio.xyz/api.php";

/** 缓存 TTL */
const TTL = {
  search: 10 * 60 * 1000,
  url: 8 * 60 * 1000,
  pic: 30 * 60 * 1000,
  lyric: 30 * 60 * 1000,
  /** 热榜每日更新，缓存 30 分钟 */
  playlist: 30 * 60 * 1000,
};

/**
 * 精选官方榜（从 toplist 全量里筛过）
 * 原则：好选、好用、少营销/车友/VIP/细分噪音
 */
export const CHART_LIST: ChartInfo[] = [
  // —— 热门：不知道听什么时优先看这里 ——
  {
    id: "19723756",
    name: "飙升榜",
    group: "featured",
    blurb: "正在变火",
    accent: "#e11d48",
  },
  {
    id: "3779629",
    name: "新歌榜",
    group: "featured",
    blurb: "新鲜首发",
    accent: "#2563eb",
  },
  {
    id: "3778678",
    name: "热歌榜",
    group: "featured",
    blurb: "全站最热",
    accent: "#ea580c",
  },
  {
    id: "2884035",
    name: "原创榜",
    group: "featured",
    blurb: "华语原创",
    accent: "#7c3aed",
  },

  // —— 风格 / 语种 / 全球 ——
  {
    id: "991319590",
    name: "说唱榜",
    group: "global",
    blurb: "中文说唱",
    accent: "#0f766e",
  },
  {
    id: "1978921795",
    name: "电音榜",
    group: "global",
    blurb: "电子音乐",
    accent: "#7c3aed",
  },
  {
    id: "71384707",
    name: "ACG 榜",
    group: "global",
    blurb: "二次元",
    accent: "#db2777",
  },
  {
    id: "5059633707",
    name: "民谣榜",
    group: "global",
    blurb: "民谣精选",
    accent: "#65a30d",
  },
  {
    id: "10520166",
    name: "摇滚榜",
    group: "global",
    blurb: "摇滚精选",
    accent: "#b91c1c",
  },
  {
    id: "5059644681",
    name: "国风榜",
    group: "global",
    blurb: "古风国风",
    accent: "#b45309",
  },
  {
    id: "71385702",
    name: "古典榜",
    group: "global",
    blurb: "古典音乐",
    accent: "#a16207",
  },
  {
    id: "2809513713",
    name: "欧美热歌",
    group: "global",
    blurb: "Western hits",
    accent: "#1d4ed8",
  },
  {
    id: "745956260",
    name: "韩语榜",
    group: "global",
    blurb: "K-Pop",
    accent: "#c026d3",
  },
  {
    id: "6077928",
    name: "日语榜",
    group: "global",
    blurb: "J-Pop",
    accent: "#e11d48",
  },
  {
    id: "60198",
    name: "Billboard",
    group: "global",
    blurb: "美国流行",
    accent: "#111827",
  },
  {
    id: "180106",
    name: "UK 榜",
    group: "global",
    blurb: "英国周榜",
    accent: "#1e3a8a",
  },
  {
    id: "60131",
    name: "Oricon",
    group: "global",
    blurb: "日本公信榜",
    accent: "#9f1239",
  },

  // —— 精选歌单：非官方榜，按主题整理的现成歌单 ——
  {
    id: "102827105",
    name: "格莱美·年度最佳",
    group: "playlist",
    blurb: "历届年度单曲",
    accent: "#c08a2e",
  },
  {
    id: "9222570215",
    name: "2026 格莱美",
    group: "playlist",
    blurb: "第 68 届全收录",
    accent: "#0e7490",
  },
];

/** 侧栏分区 */
export const CHART_GROUPS: {
  key: ChartInfo["group"];
  label: string;
  desc: string;
}[] = [
  // 精选歌单放最上面，避免被长列表顶到看不见的地方
  {
    key: "playlist",
    label: "精选歌单",
    desc: "格莱美 · 获奖精选",
  },
  {
    key: "featured",
    label: "热门",
    desc: "飙升 · 新歌 · 热歌 · 原创",
  },
  {
    key: "global",
    label: "风格与全球",
    desc: "说唱 · ACG · Billboard 等",
  },
];

/** CRC32（大写 8 位 hex），用于 playlist 接口 s 参数 */
function crc32Hex(input: string): string {
  let c = 0xffffffff;
  for (let i = 0; i < input.length; i++) {
    c ^= input.charCodeAt(i);
    for (let j = 0; j < 8; j++) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
  }
  return ((c ^ 0xffffffff) >>> 0)
    .toString(16)
    .toUpperCase()
    .padStart(8, "0");
}

function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    !!(window as any).__TAURI_INTERNALS__
  );
}

async function rawApiGet<T>(params: Record<string, string | number>): Promise<T> {
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    query[k] = String(v);
  }

  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<T>("proxy_api", { params: query });
  }

  return ofetch<T>(BASE, {
    query,
    timeout: 20000,
  });
}

async function apiGet<T>(
  params: Record<string, string | number>,
  ttlMs: number,
  options?: { bypassCache?: boolean },
): Promise<T> {
  const key = cacheKey(
    Object.fromEntries(
      Object.entries(params).map(([k, v]) => [k, String(v)]),
    ),
  );
  return cachedRequest(key, ttlMs, () => rawApiGet<T>(params), options);
}

/** 规范化音源参数（去掉 _album / _playlist 后缀，用于播放 / 歌词 / 封面） */
export function resolveSearchSource(source: string): string {
  return String(source || "netease").replace(/_(album|playlist)$/i, "");
}

/** 专辑曲目检索用的 source，如 netease_album */
export function toAlbumSearchSource(source: string): string {
  const base = resolveSearchSource(source);
  return `${base}_album`;
}

/** 歌单曲目检索用的 source，如 netease_playlist */
export function toPlaylistSearchSource(source: string): string {
  const base = resolveSearchSource(source);
  return `${base}_playlist`;
}

async function searchRaw(
  name: string,
  apiSource: string,
  count: number,
  pages: number,
  bypassCache = false,
): Promise<Track[]> {
  const data = await apiGet<Track[] | { data?: Track[] } | null>(
    {
      types: "search",
      source: apiSource,
      name,
      count,
      pages,
      s: crc32Hex(name),
    },
    TTL.search,
    { bypassCache },
  );

  // 归一化时用去掉 _album/_playlist 的音源，保证播放 / 歌词链路正确
  const playSource = resolveSearchSource(apiSource);
  if (Array.isArray(data)) return normalizeTracks(data, playSource);
  if (data && Array.isArray((data as { data?: Track[] }).data)) {
    return normalizeTracks((data as { data: Track[] }).data, playSource);
  }
  return [];
}

/** 搜索曲目；force=true 时跳过缓存（用户主动点搜索） */
export async function searchTracks(options: {
  name: string;
  source?: MusicSource | string;
  count?: number;
  pages?: number;
  force?: boolean;
}): Promise<Track[]> {
  const {
    name,
    source = "netease",
    count = 20,
    pages = 1,
    force = false,
  } = options;

  return searchRaw(
    name,
    resolveSearchSource(source),
    count,
    pages,
    force,
  );
}

/**
 * 按专辑名拉取专辑内曲目（source 使用 xxx_album）。
 * 接口无 album_id，只能用专辑名字符串检索。
 */
export async function searchAlbumTracks(options: {
  name: string;
  source?: MusicSource | string;
  count?: number;
  pages?: number;
  force?: boolean;
}): Promise<Track[]> {
  const {
    name,
    source = "netease",
    count = 20,
    pages = 1,
    force = false,
  } = options;

  return searchRaw(
    name,
    toAlbumSearchSource(source),
    count,
    pages,
    force,
  );
}

/**
 * 按歌单名拉取歌单内曲目（source 使用 xxx_playlist）。
 * 逻辑与专辑检索一致。
 */
export async function searchPlaylistTracks(options: {
  name: string;
  source?: MusicSource | string;
  count?: number;
  pages?: number;
  force?: boolean;
}): Promise<Track[]> {
  const {
    name,
    source = "netease",
    count = 20,
    pages = 1,
    force = false,
  } = options;

  return searchRaw(
    name,
    toPlaylistSearchSource(source),
    count,
    pages,
    force,
  );
}

function normalizeTracks(list: Track[], fallbackSource: string): Track[] {
  return list.map((t) => ({
    ...t,
    id: t.id,
    name: t.name ?? "未知曲目",
    artist: Array.isArray(t.artist)
      ? t.artist
      : t.artist
        ? [String(t.artist)]
        : ["未知歌手"],
    album: t.album ?? "",
    pic_id: t.pic_id,
    lyric_id: t.lyric_id ?? t.id,
    source: (t.source || fallbackSource) as MusicSource,
  }));
}

/** 网易云原始曲目结构（playlist 接口） */
interface NeteaseRawTrack {
  id: string | number;
  name?: string;
  ar?: { id?: number; name?: string }[];
  artists?: { id?: number; name?: string }[] | string[];
  al?: {
    id?: number;
    name?: string;
    picUrl?: string;
    pic_str?: string;
    pic?: number | string;
  };
  album?: { name?: string; picUrl?: string; pic_str?: string; pic?: number | string };
}

interface PlaylistApiResponse {
  code?: number;
  playlist?: {
    id?: string | number;
    name?: string;
    description?: string | null;
    coverImgUrl?: string;
    trackCount?: number;
    playCount?: number;
    updateTime?: number;
    tracks?: NeteaseRawTrack[] | null;
  } | null;
}

function normalizeHttps(url: string): string {
  if (!url) return "";
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("http://")) return `https://${url.slice(7)}`;
  return url;
}

function mapNeteaseTrack(raw: NeteaseRawTrack): Track {
  const artists = raw.ar ?? raw.artists ?? [];
  const artistNames = artists
    .map((a) => (typeof a === "string" ? a : a?.name || ""))
    .filter(Boolean);
  const album = raw.al ?? raw.album;
  const picId =
    album?.pic_str ?? album?.pic ?? "";
  const picUrl = normalizeHttps(album?.picUrl || "");

  return {
    id: raw.id,
    name: raw.name ?? "未知曲目",
    artist: artistNames.length ? artistNames : ["未知歌手"],
    album: album?.name ?? "",
    pic_id: picId,
    lyric_id: raw.id,
    source: "netease",
    picUrl: picUrl || undefined,
  };
}

/** 获取歌单 / 热榜详情 */
export async function fetchPlaylist(id: string | number): Promise<PlaylistDetail> {
  const idStr = String(id);
  const data = await apiGet<PlaylistApiResponse | null>(
    {
      types: "playlist",
      id: idStr,
      s: crc32Hex(idStr),
    },
    TTL.playlist,
  );

  const pl = data?.playlist;
  if (!pl || (data?.code != null && data.code !== 200)) {
    throw new Error("获取热榜失败");
  }

  const tracks = Array.isArray(pl.tracks)
    ? pl.tracks.map(mapNeteaseTrack)
    : [];

  return {
    id: pl.id ?? idStr,
    name: pl.name ?? "热榜",
    description: pl.description || "",
    coverImgUrl: normalizeHttps(pl.coverImgUrl || ""),
    trackCount: pl.trackCount ?? tracks.length,
    playCount: pl.playCount ?? 0,
    updateTime: pl.updateTime ?? 0,
    tracks,
  };
}

/** 获取播放地址 */
export async function fetchPlayUrl(
  id: string | number,
  source: string = "netease",
  br: Bitrate = 320,
): Promise<UrlResult | null> {
  try {
    const data = await apiGet<UrlResult | null>(
      {
        types: "url",
        source: resolveSearchSource(source),
        id: String(id),
        br,
      },
      TTL.url,
    );
    if (data && data.url) return data;
    return null;
  } catch {
    return null;
  }
}

/** 获取封面 */
export async function fetchPicUrl(
  picId: string | number,
  source: string = "netease",
  size: 300 | 500 = 300,
): Promise<string> {
  try {
    const data = await apiGet<PicResult | null>(
      {
        types: "pic",
        source: resolveSearchSource(source),
        id: String(picId),
        size,
      },
      TTL.pic,
    );
    return data?.url || "";
  } catch {
    return "";
  }
}

/** 获取歌词 */
export async function fetchLyric(
  lyricId: string | number,
  source: string = "netease",
): Promise<LyricResult> {
  try {
    const data = await apiGet<LyricResult | null>(
      {
        types: "lyric",
        source: resolveSearchSource(source),
        id: String(lyricId),
      },
      TTL.lyric,
    );
    return {
      lyric: data?.lyric || "",
      tlyric: data?.tlyric || "",
    };
  } catch {
    return { lyric: "", tlyric: "" };
  }
}

export const MUSIC_SOURCES: { label: string; value: MusicSource }[] = [
  { label: "网易云", value: "netease" },
  { label: "QQ 音乐", value: "tencent" },
  { label: "酷我", value: "kuwo" },
  { label: "Bilibili", value: "bilibili" },
  { label: "Apple Music", value: "apple" },
  { label: "YouTube Music", value: "ytmusic" },
  { label: "Spotify", value: "spotify" },
  { label: "JOOX", value: "joox" },
  { label: "Tidal", value: "tidal" },
  { label: "Qobuz", value: "qobuz" },
];

export const BITRATE_OPTIONS: { label: string; value: Bitrate }[] = [
  { label: "128K", value: 128 },
  { label: "192K", value: 192 },
  { label: "320K", value: 320 },
  { label: "无损 16bit", value: 740 },
  { label: "无损 24bit", value: 999 },
];
