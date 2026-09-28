<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from "vue";
import { useRouter } from "vue-router";
import { NButton, NEmpty, NSpin, useMessage } from "naive-ui";
import { CHART_GROUPS, CHART_LIST, fetchPlaylist } from "../api/music";
import type { ChartInfo, PlaylistDetail, Track } from "../types/music";
import { usePlayerStore } from "../stores/player";
import { useFavoritesStore } from "../stores/favorites";
import TrackList from "./TrackList.vue";
import Icon from "./Icon.vue";
import { useDownloadModal } from "../composables/useDownloadModal";

const router = useRouter();
const player = usePlayerStore();
const message = useMessage();
const favorites = useFavoritesStore();
const { open: openDownload } = useDownloadModal();

const charts = CHART_LIST;
const groups = CHART_GROUPS;

/** 首屏只挂这么多行，下一帧再补全（播放全部仍用完整 tracks） */
const PREVIEW_COUNT = 16;

const activeId = ref(charts[0]?.id ?? "19723756");
const loading = ref(false);
const playingAll = ref(false);
const detail = ref<PlaylistDetail | null>(null);
const cache = new Map<string, PlaylistDetail>();
/** 列表展示用（可先少后多）；与 detail.tracks 分离，避免同帧渲染 100+ 行 */
const listTracks = shallowRef<Track[]>([]);

const activeChart = computed(
  () => charts.find((c) => c.id === activeId.value) ?? charts[0] ?? null,
);

/** 详情是否属于当前选中榜（切换瞬间 detail 可能仍是上一榜） */
const detailReady = computed(() => {
  const d = detail.value;
  if (!d) return false;
  return String(d.id) === String(activeId.value);
});

const tracks = computed(() =>
  detailReady.value ? (detail.value?.tracks ?? []) : [],
);

/** 仅当前榜就绪且非 loading 时展示列表，避免错榜闪一下 */
const showTrackList = computed(
  () => detailReady.value && !loading.value && listTracks.value.length > 0,
);

const activeTrackKey = computed(() => {
  const t = player.currentTrack;
  return t ? `${t.source}-${t.id}` : "";
});

const sections = computed(() =>
  groups
    .map((g) => ({
      ...g,
      items: charts.filter((c) => c.group === g.key),
    }))
    .filter((s) => s.items.length > 0),
);

const coverFallbackStyle = computed(() => {
  const a = accentOf(activeChart.value);
  return {
    background: `linear-gradient(145deg, ${a} 0%, color-mix(in srgb, ${a} 45%, #0c0c0c) 100%)`,
  };
});

const heroCoverUrl = computed(() =>
  detailReady.value ? detail.value?.coverImgUrl || "" : "",
);

/** 封面图加载完成后再淡入，避免白底闪一下 */
const coverImgLoaded = ref(false);

watch(heroCoverUrl, (url) => {
  coverImgLoaded.value = false;
  if (!url) return;
  // 缓存图可能瞬间 complete，下一帧检查
  requestAnimationFrame(() => {
    const img = coverImgEl.value;
    if (img?.complete && img.naturalWidth > 0) {
      coverImgLoaded.value = true;
    }
  });
});

const coverImgEl = ref<HTMLImageElement | null>(null);

function onCoverLoad() {
  coverImgLoaded.value = true;
}

function onCoverError() {
  coverImgLoaded.value = false;
}

const heroDescription = computed(() => {
  if (detailReady.value && detail.value?.description) {
    return detail.value.description;
  }
  return activeChart.value?.blurb || "";
});

function formatPlayCount(n: number): string {
  if (!n || n <= 0) return "";
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)} 亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)} 万`;
  return String(n);
}

function formatUpdateTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

function accentOf(c: ChartInfo | null | undefined) {
  return c?.accent || "var(--primary)";
}

/** 请求序号：快速连点时丢弃过期响应 */
let loadSeq = 0;

/**
 * 列表数据分两帧挂：首屏切片 → 下一帧全量。
 * 切勿在 click 同步路径里调用。
 */
function mountListTracks(all: Track[], seq: number) {
  if (all.length <= PREVIEW_COUNT) {
    listTracks.value = all;
    return;
  }
  listTracks.value = all.slice(0, PREVIEW_COUNT);
  requestAnimationFrame(() => {
    if (seq !== loadSeq) return;
    listTracks.value = all;
  });
}

/**
 * 拉数 / 读缓存（仅在 paint 之后调用）。
 * 有缓存：先提交 detail（头图），再 rAF 挂列表，避免与 click 同帧。
 */
async function loadChart(id: string, force = false) {
  const seq = ++loadSeq;

  if (!force && cache.has(id)) {
    const cached = cache.get(id)!;
    // 头图可先对齐；列表仍 loading，避免闪旧曲目
    detail.value = cached;
    listTracks.value = [];
    requestAnimationFrame(() => {
      if (seq !== loadSeq || activeId.value !== id) return;
      mountListTracks(cached.tracks, seq);
      loading.value = false;
    });
    return;
  }

  listTracks.value = [];
  detail.value = null;
  loading.value = true;

  try {
    const data = await fetchPlaylist(id);
    if (seq !== loadSeq || activeId.value !== id) return;
    cache.set(id, data);
    detail.value = data;
    listTracks.value = [];
    requestAnimationFrame(() => {
      if (seq !== loadSeq || activeId.value !== id) return;
      mountListTracks(data.tracks, seq);
      loading.value = false;
    });
  } catch (e) {
    if (seq !== loadSeq || activeId.value !== id) return;
    detail.value = null;
    listTracks.value = [];
    message.error(e instanceof Error ? e.message : "加载榜单失败");
    if (seq === loadSeq && activeId.value === id) loading.value = false;
  }
}

/**
 * 点击帧只做两件事：改选中 + 标 loading。
 * 列表/缓存读取全部丢到下一帧，保证左侧高亮即时跟手。
 */
function selectChart(id: string) {
  if (id === activeId.value) return;
  activeId.value = id;
  loading.value = true;
  requestAnimationFrame(() => {
    if (activeId.value !== id) return;
    void loadChart(id);
  });
}

async function onPlay(track: Track) {
  await player.playTrack(track);
  if (player.error) message.error(player.error);
}

function onAdd(track: Track) {
  player.addToQueue(track);
  message.success("已加入队列");
}

async function playAll() {
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

function addAllToQueue() {
  if (!tracks.value.length) return;
  const before = player.queue.length;
  player.addManyToQueue(tracks.value);
  const added = player.queue.length - before;
  message.success(added > 0 ? `已加入 ${added} 首到队列` : "歌曲已在队列中");
}

function likeAll() {
  if (!tracks.value.length) return;
  const added = favorites.likeMany(tracks.value);
  message.success(
    added > 0
      ? `已收藏 ${added} 首到「我喜欢的音乐」`
      : "这些歌都已经收藏过了",
  );
}

function openAlbum(track: Track) {
  const name = (track.album || "").trim();
  if (!name) {
    message.warning("该曲目没有专辑信息");
    return;
  }
  void router.push({
    name: "album",
    query: {
      name,
      source: String(track.source || "netease"),
    },
  });
}

function refresh() {
  void loadChart(activeId.value, true);
}

onMounted(() => {
  void loadChart(activeId.value);
});
</script>

<template>
  <div class="page-root charts-split">
    <!-- 左侧：单行榜单导航 -->
    <aside class="charts-sider" aria-label="发现">
      <div class="sider-scroll">
        <section
          v-for="sec in sections"
          :key="sec.key"
          class="sider-section"
        >
          <div class="sider-section-label">{{ sec.label }}</div>
          <button
            v-for="c in sec.items"
            :key="c.id"
            type="button"
            class="sider-item"
            :class="{ active: c.id === activeId }"
            :title="c.blurb || c.name"
            @click="selectChart(c.id)"
          >
            <span
              class="sider-dot"
              :style="{ background: accentOf(c) }"
              aria-hidden="true"
            />
            <span class="sider-item-name truncate">{{ c.name }}</span>
          </button>
        </section>
      </div>
    </aside>

    <!-- 右侧：歌单详情头图 + 曲目 -->
    <div class="charts-main">
      <header class="hero">
        <!-- 始终用榜单强调色打底，封面淡入，切换时不再露白 -->
        <div class="hero-cover" :style="coverFallbackStyle">
          <img
            v-if="heroCoverUrl"
            :key="heroCoverUrl"
            ref="coverImgEl"
            class="hero-cover-img"
            :class="{ loaded: coverImgLoaded }"
            :src="heroCoverUrl"
            :alt="activeChart?.name || '榜单'"
            referrerpolicy="no-referrer"
            @load="onCoverLoad"
            @error="onCoverError"
          />
          <Icon
            v-show="!heroCoverUrl || !coverImgLoaded"
            name="ri:bar-chart-grouped-line"
            :size="40"
            color="rgba(255,255,255,0.92)"
            class="hero-cover-icon"
          />
        </div>

        <div class="hero-body min-w-0">
          <!-- 标题跟 activeChart，点击瞬间就变，不依赖 detail -->
          <h2 class="hero-title">
            {{ activeChart?.name || "榜单" }}
          </h2>
          <p v-if="heroDescription" class="hero-desc">
            {{ heroDescription }}
          </p>
          <div v-if="detailReady && detail" class="hero-stats">
            <span v-if="detail.trackCount" class="stat-pill">
              <Icon name="ri:music-2-line" :size="13" />
              {{ detail.trackCount }} 首
            </span>
            <span v-if="detail.playCount" class="stat-pill">
              <Icon name="ri:headphone-line" :size="13" />
              {{ formatPlayCount(detail.playCount) }} 次播放
            </span>
            <span v-if="detail.updateTime" class="stat-pill">
              <Icon name="ri:time-line" :size="13" />
              {{ formatUpdateTime(detail.updateTime) }} 更新
            </span>
          </div>
          <div class="hero-actions">
            <NButton
              type="primary"
              :disabled="!tracks.length"
              :loading="playingAll"
              @click="playAll"
            >
              <template #icon>
                <Icon name="ri:play-fill" :size="16" />
              </template>
              播放全部
            </NButton>
            <NButton :disabled="!tracks.length" @click="addAllToQueue">
              <template #icon>
                <Icon name="ri:play-list-add-line" :size="16" />
              </template>
              加入队列
            </NButton>
            <NButton :disabled="!tracks.length" @click="likeAll">
              <template #icon>
                <Icon name="ri:heart-3-fill" :size="16" />
              </template>
              全部收藏
            </NButton>
            <button
              type="button"
              class="icon-btn"
              title="刷新"
              :disabled="loading"
              @click="refresh"
            >
              <Icon
                :name="loading ? 'ri:loader-4-line' : 'ri:refresh-line'"
                :size="18"
                :class="{ spinning: loading }"
              />
            </button>
          </div>
        </div>
      </header>

      <div class="main-list">
        <NSpin :show="loading || !detailReady" class="spin-fill" description="加载中…">
          <TrackList
            v-show="showTrackList"
            :tracks="listTracks"
            :virtual="true"
            :active-key="activeTrackKey"
            album-link
            @play="onPlay"
            @add="onAdd"
            @download="openDownload"
            @open-album="openAlbum"
          />
          <div
            v-if="!loading && detailReady && !listTracks.length"
            class="empty-box"
          >
            <NEmpty description="暂无榜单数据" />
          </div>
          <div
            v-else-if="loading || !detailReady"
            class="empty-box loading-box"
          />
        </NSpin>
      </div>
    </div>
  </div>
</template>

<style scoped>
.charts-split {
  flex-direction: row;
  align-items: stretch;
  gap: 0;
  padding: 0;
  overflow: hidden;
}

/* —— 左侧 —— */
.charts-sider {
  width: 200px;
  min-width: 180px;
  max-width: 220px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
  background: color-mix(in srgb, var(--surface) 30%, transparent);
}

.sider-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 12px 8px 14px;
  overscroll-behavior: contain;
}

.sider-section {
  margin-bottom: 12px;
}

.sider-section:first-child .sider-section-label {
  padding-top: 4px;
}

.sider-section:last-child {
  margin-bottom: 2px;
}

.sider-section-label {
  padding: 8px 10px 5px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--text-faint);
  user-select: none;
}

.sider-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 9px;
  height: 36px;
  padding: 0 10px;
  margin-bottom: 1px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  text-align: left;
  transition: background 0.12s;
}

.sider-item:hover {
  background: var(--surface-2);
}

.sider-item.active {
  background: var(--primary-soft);
}

.sider-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.sider-item.active .sider-dot {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 24%, transparent);
}

.sider-item-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
  line-height: 1;
  color: var(--text);
}

.sider-item.active .sider-item-name {
  font-weight: 600;
  color: var(--primary);
}

/* —— 右侧主区 —— */
.charts-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 歌单详情头：大封面 + 纵向信息，不再挤成一条小工具栏 */
.hero {
  flex-shrink: 0;
  display: flex;
  align-items: flex-end;
  gap: 22px;
  padding: 22px 24px 18px;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--surface-2) 55%, transparent) 0%,
    transparent 100%
  );
  border-bottom: 1px solid color-mix(in srgb, var(--border) 35%, transparent);
}

.hero-cover {
  position: relative;
  width: 148px;
  height: 148px;
  flex-shrink: 0;
  border-radius: 10px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow:
    0 12px 32px rgba(0, 0, 0, 0.28),
    0 2px 8px rgba(0, 0, 0, 0.12);
}

.hero-cover-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  opacity: 0;
  transition: opacity 0.22s ease;
  z-index: 1;
}

.hero-cover-img.loaded {
  opacity: 1;
}

.hero-cover-icon {
  position: relative;
  z-index: 0;
  pointer-events: none;
}

.hero-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-bottom: 2px;
}

.hero-title {
  margin: 0;
  font-size: 32px;
  font-weight: 800;
  letter-spacing: -0.03em;
  line-height: 1.15;
  color: var(--text);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.hero-desc {
  margin: 0;
  max-width: 560px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-muted);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.hero-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 2px;
}

.stat-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-faint);
  line-height: 1;
}

.hero-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 6px;
}

.icon-btn {
  width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 50%;
  background: color-mix(in srgb, var(--surface-2) 80%, transparent);
  color: var(--text-muted);
  cursor: pointer;
  transition:
    color 0.12s,
    background 0.12s;
}

.icon-btn:hover:not(:disabled) {
  color: var(--text);
  background: var(--surface-2);
}

.icon-btn:disabled {
  opacity: 0.75;
  cursor: default;
}

.spinning {
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.main-list {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 4px 16px 8px;
}

.spin-fill {
  width: 100%;
  height: 100%;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.spin-fill :deep(.n-spin-content) {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  flex: 1;
}

.empty-box {
  min-height: 200px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.loading-box {
  min-height: 240px;
}

@media (max-width: 900px) {
  .hero-cover {
    width: 120px;
    height: 120px;
  }
  .hero-title {
    font-size: 26px;
  }
}

@media (max-width: 720px) {
  .charts-sider {
    width: 156px;
    min-width: 140px;
  }
  .hero {
    gap: 14px;
    padding: 16px 14px 14px;
  }
  .hero-cover {
    width: 96px;
    height: 96px;
  }
  .hero-title {
    font-size: 22px;
  }
  .hero-desc {
    -webkit-line-clamp: 1;
  }
}
</style>
