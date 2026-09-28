<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  NButton,
  NEmpty,
  NSpin,
  useMessage,
} from "naive-ui";
import {
  fetchPicUrl,
  searchAlbumTracks,
  searchPlaylistTracks,
} from "../api/music";
import type { Track } from "../types/music";
import { usePlayerStore } from "../stores/player";
import { useFavoritesStore } from "../stores/favorites";
import TrackList from "./TrackList.vue";
import Icon from "./Icon.vue";
import { useDownloadModal } from "../composables/useDownloadModal";

/** 专辑 / 歌单共用详情页 */
type CollectionKind = "album" | "playlist";

const route = useRoute();
const router = useRouter();
const player = usePlayerStore();
const message = useMessage();
const favorites = useFavoritesStore();
const { open: openDownload } = useDownloadModal();

const loading = ref(false);
const loadingMore = ref(false);
const loadError = ref(false);
const playingAll = ref(false);
const tracks = ref<Track[]>([]);
const page = ref(1);
const pageSize = 20;
const coverUrl = ref("");
const errorText = ref("");

let loadSeq = 0;

const kind = computed<CollectionKind>(() =>
  route.name === "playlist" ? "playlist" : "album",
);
const collectionName = computed(() => String(route.query.name || "").trim());
const source = computed(() => String(route.query.source || "netease").trim() || "netease");

const kindLabel = computed(() => (kind.value === "playlist" ? "歌单" : "专辑"));
const unknownName = computed(() =>
  kind.value === "playlist" ? "未知歌单" : "未知专辑",
);
const coverIcon = computed(() =>
  kind.value === "playlist" ? "ri:play-list-2-line" : "ri:album-line",
);

const artistSummary = computed(() => {
  const counts = new Map<string, number>();
  for (const t of tracks.value) {
    for (const a of t.artist || []) {
      const name = String(a).trim();
      if (!name) continue;
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  }
  if (!counts.size) return kind.value === "playlist" ? "歌单" : "未知歌手";
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
});

async function fetchCollectionPage(name: string, pages: number, force: boolean) {
  if (kind.value === "playlist") {
    return searchPlaylistTracks({
      name,
      source: source.value,
      count: pageSize,
      pages,
      force,
    });
  }
  return searchAlbumTracks({
    name,
    source: source.value,
    count: pageSize,
    pages,
    force,
  });
}

const activeTrackKey = computed(() => {
  const t = player.currentTrack;
  return t ? `${t.source}-${t.id}` : "";
});

function trackKey(t: Track) {
  return `${t.source}-${t.id}`;
}

function mergeUnique(base: Track[], extra: Track[]) {
  const seen = new Set(base.map(trackKey));
  const out = [...base];
  for (const t of extra) {
    const k = trackKey(t);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

async function resolveCover(list: Track[]) {
  const first = list.find((t) => t.picUrl) || list[0];
  if (first?.picUrl) {
    coverUrl.value = first.picUrl;
  } else if (first?.pic_id != null && first.pic_id !== "") {
    coverUrl.value = await fetchPicUrl(first.pic_id, first.source || source.value, 500);
  } else {
    coverUrl.value = "";
  }
}

async function loadCollection(reset: boolean) {
  const name = collectionName.value;
  if (!name) {
    tracks.value = [];
    errorText.value = `缺少${kindLabel.value}名`;
    coverUrl.value = "";
    loadError.value = false;
    return;
  }

  if (reset) {
    const seq = ++loadSeq;
    page.value = 1;
    loading.value = true;
    loadingMore.value = false;
    loadError.value = false;
    errorText.value = "";
    try {
      const list = await fetchCollectionPage(name, 1, true);
      if (seq !== loadSeq) return;

      tracks.value = list;
      loadError.value = false;

      if (!list.length) {
        errorText.value = `暂无${kindLabel.value}曲目（可能音源不支持、名称无匹配或接口限流）`;
        coverUrl.value = "";
        loadError.value = true;
        return;
      }

      await resolveCover(list);
    } catch (e) {
      if (seq !== loadSeq) return;
      tracks.value = [];
      coverUrl.value = "";
      loadError.value = true;
      errorText.value = e instanceof Error ? e.message : `加载${kindLabel.value}失败`;
      message.error(errorText.value);
    } finally {
      if (seq === loadSeq) loading.value = false;
    }
    return;
  }

  await loadMoreTracks();
}

/** 加载更多：永不「没有更多」；空/失败可点或再滚重试 */
async function loadMoreTracks() {
  const name = collectionName.value;
  if (!name) return;
  if (loading.value || loadingMore.value) return;

  const seq = loadSeq;
  const nextPage = page.value + 1;
  loadingMore.value = true;
  loadError.value = false;
  try {
    const list = await fetchCollectionPage(name, nextPage, true);
    if (seq !== loadSeq) return;

    if (!list.length) {
      loadError.value = true;
      return;
    }

    const before = tracks.value.length;
    tracks.value = mergeUnique(tracks.value, list);
    const added = tracks.value.length - before;
    page.value = nextPage;
    if (added === 0) loadError.value = true;
  } catch (e) {
    if (seq !== loadSeq) return;
    loadError.value = true;
    message.error(e instanceof Error ? e.message : "加载更多失败");
  } finally {
    if (seq === loadSeq) loadingMore.value = false;
  }
}

watch(
  () => [route.name, route.query.name, route.query.source] as const,
  () => {
    void loadCollection(true);
  },
  { immediate: true },
);

function goBack() {
  if (window.history.length > 1) {
    router.back();
  } else {
    router.replace({ name: "main" });
  }
}

async function onPlay(track: Track) {
  // 单曲播放：只播当前歌曲，不自动把整个列表加入队列；
  // 整张播放 / 加入队列请用「播放全部 / 加入队列」按钮
  await player.playTrack(track);
  if (player.error) message.error(player.error);
}

function onAdd(track: Track) {
  player.addToQueue(track);
  message.success("已加入队列");
}

async function playLoaded() {
  if (!tracks.value.length) return;
  playingAll.value = true;
  try {
    await player.playAll(tracks.value, 0);
    if (player.error) message.error(player.error);
    else message.success(`已开始播放，共 ${tracks.value.length} 首`);
  } finally {
    playingAll.value = false;
  }
}

function addLoadedToQueue() {
  if (!tracks.value.length) return;
  const before = player.queue.length;
  player.addManyToQueue(tracks.value);
  const added = player.queue.length - before;
  message.success(added > 0 ? `已加入 ${added} 首到队列` : "歌曲已在队列中");
}

function likeLoaded() {
  if (!tracks.value.length) return;
  const added = favorites.likeMany(tracks.value);
  message.success(
    added > 0
      ? `已收藏 ${added} 首到「我喜欢的音乐」`
      : "这些歌都已经收藏过了",
  );
}
</script>

<template>
  <div class="page-root">
    <header class="page-header album-header">
      <button type="button" class="back-btn" title="返回" @click="goBack">
        <Icon name="ri:arrow-left-line" :size="18" />
        <span>返回</span>
      </button>
    </header>

    <div class="album-hero">
      <div class="cover">
        <img
          v-if="coverUrl"
          :src="coverUrl"
          alt=""
          referrerpolicy="no-referrer"
        />
        <Icon
          v-else
          :name="coverIcon"
          :size="36"
          color="var(--text-faint)"
        />
      </div>
      <div class="hero-meta min-w-0">
        <div class="hero-label">{{ kindLabel }}</div>
        <h1 class="page-title truncate" :title="collectionName || unknownName">
          {{ collectionName || unknownName }}
        </h1>
        <p class="page-subtitle truncate">
          {{ artistSummary }}
          <span v-if="source" class="src-tag"> · {{ source }}</span>
        </p>
        <div class="hero-actions">
          <NButton
            type="primary"
            size="small"
            :loading="playingAll"
            :disabled="!tracks.length"
            @click="playLoaded"
          >
            <template #icon>
              <Icon name="ri:play-fill" :size="14" />
            </template>
            播放已加载
          </NButton>
          <NButton size="small" :disabled="!tracks.length" @click="addLoadedToQueue">
            <template #icon>
              <Icon name="ri:play-list-add-line" :size="14" />
            </template>
            加入队列
          </NButton>
          <NButton size="small" :disabled="!tracks.length" @click="likeLoaded">
            <template #icon>
              <Icon name="ri:heart-3-fill" :size="14" />
            </template>
            全部收藏
          </NButton>
          <span v-if="tracks.length" class="meta-count">已加载 {{ tracks.length }} 首</span>
        </div>
      </div>
    </div>

    <div class="page-body list-body">
      <NSpin :show="loading" class="spin-fill">
        <TrackList
          v-if="tracks.length"
          :tracks="tracks"
          :virtual="tracks.length > 40"
          :active-key="activeTrackKey"
          :album-link="false"
          infinite
          :loading-more="loadingMore"
          :load-error="loadError"
          @play="onPlay"
          @add="onAdd"
          @download="openDownload"
          @load-more="loadMoreTracks"
        />
        <div v-else class="empty-box">
          <NEmpty :description="errorText || '暂无曲目'" />
          <NButton
            v-if="collectionName"
            size="small"
            class="mt-3"
            :loading="loading"
            @click="loadCollection(true)"
          >
            {{ loadError ? "点击加载更多" : "重试" }}
          </NButton>
        </div>
      </NSpin>
    </div>
  </div>
</template>

<style scoped>
.album-header {
  padding-bottom: 0;
}

.back-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: 13px;
  cursor: pointer;
  padding: 4px 0;
  border-radius: var(--radius-sm);
}

.back-btn:hover {
  color: var(--text);
}

.album-hero {
  display: flex;
  gap: 16px;
  align-items: flex-end;
  padding: 8px 0 12px;
  flex-shrink: 0;
}

.cover {
  width: 120px;
  height: 120px;
  border-radius: var(--radius-md, 8px);
  overflow: hidden;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface-2);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
}

.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.hero-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-bottom: 2px;
}

.hero-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-faint);
}

.src-tag {
  color: var(--text-faint);
  font-size: 12px;
}

.hero-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}

.meta-count {
  font-size: 12px;
  color: var(--text-faint);
}

.list-body {
  min-height: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
}

.spin-fill {
  width: 100%;
  height: 100%;
  min-height: 200px;
  display: flex;
  flex-direction: column;
}

.spin-fill :deep(.n-spin-content) {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.empty-box {
  min-height: 200px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.mt-3 {
  margin-top: 12px;
}

@media (max-width: 640px) {
  .cover {
    width: 88px;
    height: 88px;
  }
}
</style>
