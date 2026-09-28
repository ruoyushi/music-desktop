import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import type { Track } from "../types/music";

const STORAGE_KEY = "music-desktop-favorites";

export interface LikedTrack extends Track {
  /** 收藏时间戳（ms），新收藏在前 */
  likedAt: number;
}

function trackKey(t: Pick<Track, "source" | "id">) {
  return `${t.source}-${t.id}`;
}

function loadFavorites(): LikedTrack[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as LikedTrack[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((t) => t && t.id != null && t.source)
      .map((t) => ({
        ...t,
        likedAt: typeof t.likedAt === "number" ? t.likedAt : Date.now(),
      }));
  } catch {
    return [];
  }
}

export const useFavoritesStore = defineStore("favorites", () => {
  const items = ref<LikedTrack[]>(loadFavorites());

  const count = computed(() => items.value.length);

  const keySet = computed(() => {
    const set = new Set<string>();
    for (const t of items.value) set.add(trackKey(t));
    return set;
  });

  watch(
    items,
    (v) => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
      } catch {
        // quota / private mode
      }
    },
    { deep: true },
  );

  function isLiked(track: Pick<Track, "source" | "id"> | null | undefined) {
    if (!track) return false;
    return keySet.value.has(trackKey(track));
  }

  /** 收藏；已存在则更新元数据并置顶，返回 true 表示新收藏 */
  function like(track: Track): boolean {
    const key = trackKey(track);
    const idx = items.value.findIndex((t) => trackKey(t) === key);
    const entry: LikedTrack = {
      ...track,
      likedAt: Date.now(),
    };
    if (idx >= 0) {
      items.value.splice(idx, 1);
      items.value.unshift(entry);
      return false;
    }
    items.value.unshift(entry);
    return true;
  }

  function unlike(track: Pick<Track, "source" | "id">) {
    const key = trackKey(track);
    const idx = items.value.findIndex((t) => trackKey(t) === key);
    if (idx < 0) return false;
    items.value.splice(idx, 1);
    return true;
  }

  /**
   * 批量收藏（整张专辑 / 整个歌单）。
   * 倒序入栈，收藏列表里保持歌单原有顺序；返回新增数量。
   */
  function likeMany(tracks: Track[]): number {
    let added = 0;
    const likedAt = Date.now();
    for (let i = tracks.length - 1; i >= 0; i -= 1) {
      const track = tracks[i];
      if (!track || track.id == null || !track.source) continue;
      const key = trackKey(track);
      const idx = items.value.findIndex((t) => trackKey(t) === key);
      if (idx >= 0) {
        items.value.splice(idx, 1);
      } else {
        added += 1;
      }
      items.value.unshift({ ...track, likedAt });
    }
    return added;
  }

  /** 切换收藏；返回切换后是否已收藏 */
  function toggle(track: Track): boolean {
    if (isLiked(track)) {
      unlike(track);
      return false;
    }
    like(track);
    return true;
  }

  function clear() {
    items.value = [];
  }

  /** 仅曲目列表（去掉 likedAt 也可直接当 Track 用） */
  const tracks = computed<Track[]>(() => items.value);

  return {
    items,
    tracks,
    count,
    isLiked,
    like,
    likeMany,
    unlike,
    toggle,
    clear,
  };
});
