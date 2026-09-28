/** 音乐源 */
export type MusicSource =
  | "netease"
  | "tencent"
  | "kuwo"
  | "tidal"
  | "qobuz"
  | "joox"
  | "bilibili"
  | "apple"
  | "ytmusic"
  | "spotify";

/** 音质 br */
export type Bitrate = 128 | 192 | 320 | 740 | 999;

/** 搜索结果曲目 */
export interface Track {
  id: string | number;
  name: string;
  artist: string[];
  album: string;
  pic_id: string | number;
  url_id?: string | number;
  lyric_id: string | number;
  source: MusicSource | string;
  /** 运行时填充 */
  picUrl?: string;
  url?: string;
}

export interface UrlResult {
  url: string;
  br: number;
  size: number;
}

export interface PicResult {
  url: string;
}

export interface LyricResult {
  lyric: string;
  tlyric?: string;
}

/**
 * 发现页分区（对齐 music.163.com/#/discover/toplist）
 * featured = 云音乐特色榜；global = 全球媒体榜
 */
export type ChartGroup = "featured" | "global" | "playlist";

/** 官方热榜 / 发现页歌单配置 */
export interface ChartInfo {
  id: string;
  name: string;
  /** 发现页分区 */
  group: ChartGroup;
  /** 卡片副文案（更新节奏等） */
  blurb?: string;
  /** 卡片强调色（无封面时的渐变） */
  accent?: string;
}

/** 歌单 / 热榜详情（归一化后） */
export interface PlaylistDetail {
  id: string | number;
  name: string;
  description: string;
  coverImgUrl: string;
  trackCount: number;
  playCount: number;
  updateTime: number;
  tracks: Track[];
}

/** list 列表循环 | single 单曲循环 | order 顺序播完停 | shuffle 列表随机 */
export type PlayMode = "list" | "single" | "order" | "shuffle";

export interface PlayerSnapshot {
  track: Track | null;
  playing: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  mode: PlayMode;
  queue: Track[];
  currentIndex: number;
  lyricText: string;
  tlyricText: string;
}
