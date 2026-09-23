<script setup lang="ts">
/**
 * 桌面歌词
 * - 顶栏拖拽；底栏悬停控制
 * - 三行歌词始终完整显示
 * - 未锁定：磨砂背景常显（保留皮肤背景图，约 90% 不透明），歌名常显；悬停再出控件
 * - 锁定后隐藏背景（仅歌词 + 解锁入口）；顶栏仍可拖
 */
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { PlayerSnapshot } from "../types/music";
import { findLyricIndex, parseLrc } from "../utils/lrc";
import Icon from "../components/Icon.vue";
import { applySkin } from "../themes/apply";
import {
  DEFAULT_DESKTOP_LYRIC_COLOR,
  DEFAULT_DESKTOP_LYRIC_FONT_SIZE,
  DEFAULT_LYRIC_LOOKAHEAD,
  readDesktopLyricAppearanceFromStorage,
  type DesktopLyricColorMode,
} from "../stores/settings";
import { openMainWindow } from "../utils/windows";

const STORAGE_KEY = "music-desktop-settings";

const state = ref<PlayerSnapshot | null>(null);
const hovered = ref(false);
const locked = ref(false);
const lyricLookAhead = ref(DEFAULT_LYRIC_LOOKAHEAD);
const colorMode = ref<DesktopLyricColorMode>("theme");
const customColor = ref(DEFAULT_DESKTOP_LYRIC_COLOR);
const fontSize = ref(DEFAULT_DESKTOP_LYRIC_FONT_SIZE);

let unlisten: (() => void) | null = null;
let unlistenCmd: (() => void) | null = null;
let skinTimer: number | null = null;
/** 系统拖拽窗口时会误发 leave/blur，拖拽中/拖完短时忽略收起悬停 */
let dragging = false;
/** 拖完后 leave/blur 常延迟到达，在此时间戳前不 clearHover */
let suppressLeaveUntil = 0;
const hoverRestoreTimers: number[] = [];

const lines = computed(() => parseLrc(state.value?.lyricText || ""));
const tlines = computed(() => parseLrc(state.value?.tlyricText || ""));

const activeIndex = computed(() =>
  findLyricIndex(
    lines.value,
    state.value?.currentTime || 0,
    lyricLookAhead.value,
  ),
);

function lineTextAt(idx: number): string {
  if (idx < 0 || idx >= lines.value.length) return "";
  const t = lines.value[idx]?.text?.trim() || "";
  if (t) return t;
  for (let i = idx + 1; i < lines.value.length; i++) {
    if (lines.value[i].text.trim()) return lines.value[i].text.trim();
  }
  for (let i = idx - 1; i >= 0; i--) {
    if (lines.value[i].text.trim()) return lines.value[i].text.trim();
  }
  return "";
}

const prevText = computed(() => {
  if (!state.value?.track || activeIndex.value <= 0) return "";
  return lineTextAt(activeIndex.value - 1);
});

const currentText = computed(() => {
  if (!state.value?.track) return "播放音乐后显示歌词";
  if (activeIndex.value < 0) {
    const first = lines.value.find((l) => l.text.trim());
    return first?.text || state.value.track.name || "♪";
  }
  return lineTextAt(activeIndex.value) || state.value.track.name || "♪";
});

const nextText = computed(() => {
  if (!state.value?.track) return "";
  if (activeIndex.value < 0) {
    return lines.value.length > 1 ? lineTextAt(1) : "";
  }
  if (activeIndex.value + 1 >= lines.value.length) return "";
  return lineTextAt(activeIndex.value + 1);
});

const currentT = computed(() => {
  if (activeIndex.value < 0) return "";
  const time = lines.value[activeIndex.value]?.time ?? 0;
  const idx = findLyricIndex(tlines.value, time, lyricLookAhead.value);
  return idx >= 0 ? tlines.value[idx]?.text || "" : "";
});

const songName = computed(() => state.value?.track?.name || "未播放");
const artist = computed(() => {
  const a = state.value?.track?.artist;
  return a?.length ? a.join(" / ") : "";
});

const accent = computed(() => {
  if (colorMode.value === "custom") return customColor.value;
  return "var(--primary)";
});

const rootStyle = computed(() => ({
  "--dl-accent": accent.value,
  "--dl-main": `${fontSize.value}px`,
  "--dl-side": `${Math.max(13, Math.round(fontSize.value * 0.62))}px`,
  "--dl-trans": `${Math.max(11, Math.round(fontSize.value * 0.48))}px`,
}));

const activeHover = computed(() => hovered.value && !locked.value);

function leaveSuppressed() {
  return dragging || Date.now() < suppressLeaveUntil;
}

function clearHover() {
  if (leaveSuppressed()) return;
  hovered.value = false;
}

function forceHover() {
  if (locked.value) return;
  hovered.value = true;
}

function clearHoverRestoreTimers() {
  while (hoverRestoreTimers.length) {
    const id = hoverRestoreTimers.pop();
    if (id != null) window.clearTimeout(id);
  }
}

/** 拖窗结束后强制恢复悬停（补偿延迟 leave/blur 与 WebView 不补 mouseenter） */
function restoreHoverAfterDrag() {
  clearHoverRestoreTimers();
  suppressLeaveUntil = Date.now() + 500;
  forceHover();
  // 同一事件循环 / 稍后再次补齐，防止晚到的 leave 把状态清掉
  for (const ms of [0, 32, 100, 200]) {
    hoverRestoreTimers.push(
      window.setTimeout(() => {
        if (!locked.value) forceHover();
      }, ms),
    );
  }
}

async function emitCmd(cmd: string) {
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit("player:cmd", cmd);
  } catch {
    // ignore
  }
}

async function closeWin() {
  locked.value = false;
  dragging = false;
  suppressLeaveUntil = 0;
  clearHoverRestoreTimers();
  hovered.value = false;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().close();
  } catch {
    // ignore
  }
}

function setLocked(v: boolean) {
  locked.value = v;
  suppressLeaveUntil = 0;
  clearHoverRestoreTimers();
  hovered.value = false;
}

function toggleLock() {
  setLocked(!locked.value);
}

function unlock() {
  setLocked(false);
}

async function showMainWindow() {
  await openMainWindow();
}

function bumpFont(delta: number) {
  fontSize.value = Math.min(56, Math.max(14, fontSize.value + delta));
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const data = raw ? JSON.parse(raw) : {};
    data.desktopLyricFontSize = fontSize.value;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // ignore
  }
}

function syncFromStorage() {
  try {
    const app = readDesktopLyricAppearanceFromStorage();
    if (app.skinId) applySkin(app.skinId);
    lyricLookAhead.value = app.lyricLookAhead;
    colorMode.value = app.colorMode;
    customColor.value = app.color;
    fontSize.value = app.fontSize;
  } catch {
    // ignore
  }
}

/** 未锁定时：指针在整窗内即显示控件（不限顶栏） */
function onEnter() {
  forceHover();
}

/** 整窗内任意移动也补一次悬停（拖完 WebView 常不补 mouseenter） */
function onPointerMove() {
  if (locked.value || dragging) return;
  if (!hovered.value) hovered.value = true;
}

function onLeave(e: MouseEvent) {
  if (leaveSuppressed()) return;
  // 从顶部移出窗口时，relatedTarget 常为 null，必须收起
  const related = e.relatedTarget as Node | null;
  if (related && (e.currentTarget as HTMLElement).contains(related)) {
    return;
  }
  clearHover();
}

/** 顶栏拖拽（锁定态也允许） */
async function onDragBarDown(e: PointerEvent) {
  if (e.button !== 0) return;
  const t = e.target as HTMLElement | null;
  if (t?.closest(".no-drag")) return;
  // 系统拖窗期间会误发 leave；拖中保持悬停态，避免控件闪没
  dragging = true;
  clearHoverRestoreTimers();
  forceHover();
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().startDragging();
  } catch {
    // ignore
  } finally {
    dragging = false;
    // 拖完后 leave 常延迟到达且 WebView 不补 mouseenter，主动恢复
    restoreHoverAfterDrag();
  }
}

/** 指针离开整个文档（从窗口任意边缘含顶部离开） */
function onDocumentPointerLeave() {
  if (leaveSuppressed()) return;
  clearHover();
}

onMounted(async () => {
  document.documentElement.classList.add("lyric-window");
  document.body.classList.add("lyric-window");
  syncFromStorage();
  skinTimer = window.setInterval(syncFromStorage, 800);

  // 顶栏移出窗口时 mouseleave 经常不触发，用 document 级兜底
  document.documentElement.addEventListener(
    "mouseleave",
    onDocumentPointerLeave,
  );
  document.addEventListener("mouseleave", onDocumentPointerLeave);
  // 指针在窗口外时（部分 WebView 用这个）
  window.addEventListener("pointerleave", onDocumentPointerLeave);

  try {
    const { listen } = await import("@tauri-apps/api/event");
    unlisten = await listen<PlayerSnapshot>("player:state", (e) => {
      state.value = e.payload;
    });
    unlistenCmd = await listen<string>("desktop-lyric:cmd", (e) => {
      if (e.payload === "unlock") unlock();
    });
    // 刚打开时主动向主窗口要一次快照，保证立即跟唱
    const { emit } = await import("@tauri-apps/api/event");
    await emit("player:state:request");
  } catch {
    // ignore
  }
});

onUnmounted(() => {
  document.documentElement.classList.remove("lyric-window");
  document.body.classList.remove("lyric-window");
  if (skinTimer != null) window.clearInterval(skinTimer);
  document.documentElement.removeEventListener(
    "mouseleave",
    onDocumentPointerLeave,
  );
  document.removeEventListener("mouseleave", onDocumentPointerLeave);
  window.removeEventListener("pointerleave", onDocumentPointerLeave);
  unlisten?.();
  unlistenCmd?.();
  dragging = false;
  suppressLeaveUntil = 0;
  clearHoverRestoreTimers();
});
</script>

<template>
  <div
    class="dl"
    :class="{
      'is-hover': activeHover,
      'is-locked': locked,
      'has-bg': !locked,
    }"
    :style="rootStyle"
    @mouseenter="onEnter"
    @mouseleave="onLeave"
    @pointermove="onPointerMove"
  >
    <!-- 圆角磨砂背景：皮肤图 + 磨砂层，未锁定常显；需可命中以接收整窗悬停 -->
    <div class="glass" :class="{ on: !locked }" aria-hidden="true">
      <div class="glass-photo" />
      <div class="glass-frost" />
    </div>

    <!-- 顶栏：整条可拖；未锁定时歌名常显，悬停再出操作按钮 -->
    <header
      class="drag-bar"
      data-tauri-drag-region
      @pointerdown="onDragBarDown"
    >
      <div class="drag-fill" data-tauri-drag-region>
        <span
          v-if="!locked"
          class="drag-meta truncate"
          data-tauri-drag-region
        >
          {{ songName }}
          <template v-if="artist"> · {{ artist }}</template>
        </span>
      </div>
      <div
        v-if="!locked"
        class="drag-actions no-drag"
        :class="{ show: activeHover }"
      >
        <button
          type="button"
          class="icon-btn"
          title="打开主窗口"
          @click.stop="showMainWindow"
        >
          <Icon name="ri:home-line" :size="14" />
        </button>
        <button
          type="button"
          class="icon-btn"
          title="锁定"
          @click.stop="toggleLock"
        >
          <Icon name="ri:lock-unlock-line" :size="14" />
        </button>
        <button
          type="button"
          class="icon-btn close"
          title="关闭"
          @click.stop="closeWin"
        >
          <Icon name="ri:close-line" :size="14" />
        </button>
      </div>
    </header>

    <!-- 锁定态：右上角固定可见的解锁入口（小胶囊，不挡歌词） -->
    <div v-if="locked" class="lock-chip no-drag">
      <button type="button" class="lock-chip-btn" title="点击解锁" @click.stop="unlock">
        <Icon name="ri:lock-fill" :size="13" />
        <span>解锁</span>
      </button>
    </div>

    <!-- 歌词区：未锁定时预留上下空间，避免移出后只剩一行字贴在大空框里 -->
    <div class="stage">
      <div class="line side" :class="{ empty: !prevText }">
        {{ prevText || "\u00a0" }}
      </div>
      <div class="line current" :key="'c-' + activeIndex">
        <div class="current-main">{{ currentText }}</div>
        <div v-if="currentT" class="current-trans">{{ currentT }}</div>
      </div>
      <div class="line side" :class="{ empty: !nextText }">
        {{ nextText || "\u00a0" }}
      </div>
    </div>

    <!-- 底栏控制：悬停显示 -->
    <footer class="dock no-drag" :class="{ show: activeHover }">
      <button type="button" class="tb-btn" title="缩小字号" @click.stop="bumpFont(-2)">
        <span class="tb-font">A−</span>
      </button>
      <button type="button" class="tb-btn" title="上一首" @click.stop="emitCmd('prev')">
        <Icon name="ri:skip-back-fill" :size="18" />
      </button>
      <button
        type="button"
        class="tb-play"
        title="播放/暂停"
        @click.stop="emitCmd('toggle')"
      >
        <Icon
          :name="state?.playing ? 'ri:pause-fill' : 'ri:play-fill'"
          :size="20"
        />
      </button>
      <button type="button" class="tb-btn" title="下一首" @click.stop="emitCmd('next')">
        <Icon name="ri:skip-forward-fill" :size="18" />
      </button>
      <button type="button" class="tb-btn" title="放大字号" @click.stop="bumpFont(2)">
        <span class="tb-font">A+</span>
      </button>
    </footer>
  </div>
</template>

<style scoped>
.dl {
  position: relative;
  width: 100vw;
  height: 100vh;
  box-sizing: border-box;
  /* 给圆角留边，避免贴边被裁 */
  padding: 6px;
  background: transparent;
  overflow: visible;
  user-select: none;
}

/* 未锁定：整窗区域可命中（透明窗仅不透明像素才吃鼠标，靠玻璃层接住） */
.dl.has-bg {
  /* 极淡底色，避免部分 WebView 在边缘漏点 */
  background: rgba(0, 0, 0, 0.001);
}

.glass {
  position: absolute;
  inset: 6px;
  z-index: 0;
  border-radius: 14px;
  pointer-events: none;
  background: transparent;
  opacity: 0;
  transition: opacity 0.18s ease;
  overflow: hidden;
}

/* 未锁定：保留皮肤背景图，整体 90% 不透明；并接收指针（整窗悬停） */
.glass.on {
  opacity: 0.9;
  border: 1px solid var(--border);
  box-shadow: var(--shadow);
  pointer-events: auto;
}

/* 底层：皮肤壁纸（一点点糊即可） */
.glass-photo {
  position: absolute;
  inset: -3px;
  background-image:
    var(--wallpaper-overlay, none),
    var(--wallpaper-image, none),
    var(--wallpaper, var(--bg));
  background-size: auto, cover, auto;
  background-position: center;
  background-repeat: no-repeat;
  filter: blur(1.5px) saturate(1.02);
  transform: scale(1.01);
}

/* 上层：磨砂遮罩（扎实） */
.glass-frost {
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--bar-bg) 78%, transparent);
}

.no-drag {
  -webkit-app-region: no-drag !important;
  app-region: no-drag !important;
}

/* 顶栏：整条拖拽，无横条/无「拖动此处」文案 */
.drag-bar {
  position: absolute;
  top: 6px;
  left: 6px;
  right: 6px;
  z-index: 5;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 6px 0 14px;
  -webkit-app-region: drag;
  app-region: drag;
  cursor: grab;
  border-radius: 14px 14px 0 0;
}

/* 锁定态顶栏仍可拖；解锁按钮用 .no-drag 排除 */
.dl.is-locked .drag-bar {
  cursor: grab;
}

.drag-bar:active {
  cursor: grabbing;
}

.drag-fill {
  flex: 1;
  min-width: 0;
  height: 100%;
  display: flex;
  align-items: center;
}

.drag-meta {
  font-size: 11px;
  color: color-mix(in srgb, var(--text-muted) 88%, transparent);
  font-weight: 500;
  max-width: 100%;
  letter-spacing: 0.01em;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.22);
  transition: color 0.12s ease;
}

.dl.is-hover .drag-meta {
  color: var(--text-muted);
}

.drag-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.12s;
}

.drag-actions.show {
  opacity: 1;
  pointer-events: auto;
}

.icon-btn {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.dl.is-hover .icon-btn {
  color: var(--text);
}

.icon-btn:hover {
  background: var(--surface-2);
  color: var(--text);
}

.icon-btn.close:hover {
  background: #e81123 !important;
  color: #fff !important;
}

/* 锁定：始终可见的小解锁按钮 */
.lock-chip {
  position: absolute;
  top: 10px;
  right: 12px;
  z-index: 8;
}

.lock-chip-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 10px 0 8px;
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  background: color-mix(in srgb, var(--bar-bg) 90%, var(--bg));
  color: var(--text);
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
  box-shadow: var(--shadow);
  backdrop-filter: blur(var(--panel-blur));
  -webkit-backdrop-filter: blur(var(--panel-blur));
}

.lock-chip-btn:hover {
  background: var(--surface-2);
  border-color: var(--primary);
  color: var(--primary);
}

/* 歌词：中间区域；未锁定时始终预留顶栏/底栏空间，移出鼠标布局不塌 */
.stage {
  position: absolute;
  top: 6px;
  bottom: 6px;
  left: 6px;
  right: 6px;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 36px 22px 20px;
  box-sizing: border-box;
  text-align: center;
  pointer-events: none;
  overflow: hidden;
  transition: padding 0.12s ease;
}

.dl.has-bg .stage {
  /* 顶栏歌名 + 底栏预留，空闲态也像完整卡片 */
  padding: 40px 24px 52px;
}

.line {
  width: 100%;
  max-width: 100%;
  /* 允许完整显示字高，横向省略 */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.45;
  flex-shrink: 0;
}

.line.side {
  font-size: var(--dl-side, 15px);
  font-weight: 500;
  /* 保证一行完整高度 */
  min-height: calc(var(--dl-side, 15px) * 1.45);
  color: rgba(255, 255, 255, 0.58);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
}

.line.side.empty {
  opacity: 0.28;
}

/* 有背景：皮肤文字色 */
.dl.has-bg .line.side {
  color: var(--text-muted);
  text-shadow: none;
}

.line.current {
  flex-shrink: 0;
  min-height: calc(var(--dl-main, 26px) * 1.45);
  animation: line-in 0.28s ease;
}

.current-main {
  font-size: var(--dl-main, 26px);
  font-weight: 700;
  letter-spacing: 0.01em;
  line-height: 1.45;
  color: var(--dl-accent, #fff);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
  /* 避免半个字被裁 */
  overflow: visible;
}

.dl.has-bg .current-main {
  color: var(--dl-accent, var(--primary));
  text-shadow: none;
}

.current-trans {
  margin-top: 4px;
  font-size: var(--dl-trans, 13px);
  font-weight: 500;
  line-height: 1.4;
  color: rgba(255, 255, 255, 0.55);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.28);
}

.dl.has-bg .current-trans {
  color: var(--text-muted);
  text-shadow: none;
}

@keyframes line-in {
  from {
    opacity: 0.5;
    transform: translateY(3px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* 底栏：绝对定位，不占歌词布局高度 */
.dock {
  position: absolute;
  left: 6px;
  right: 6px;
  bottom: 6px;
  z-index: 5;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-radius: 0 0 14px 14px;
  opacity: 0;
  transform: translateY(4px);
  pointer-events: none;
  transition:
    opacity 0.12s ease,
    transform 0.12s ease;
}

.dock.show {
  opacity: 1;
  transform: translateY(0);
  pointer-events: auto;
}

.tb-btn {
  width: 34px;
  height: 34px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-muted);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.dl.is-hover .tb-btn {
  color: var(--text);
}

.tb-btn:hover {
  background: var(--surface-2);
  color: var(--text);
}

.tb-play {
  width: 40px;
  height: 40px;
  border: none;
  border-radius: 50%;
  background: var(--primary);
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.tb-play:hover {
  transform: scale(1.05);
  background: var(--primary-hover);
}

.tb-font {
  font-size: 12px;
  font-weight: 700;
}

.truncate {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>

<style>
html.lyric-window,
body.lyric-window,
.lyric-window #app {
  background: transparent !important;
  background-color: transparent !important;
  overflow: hidden !important;
  border: none !important;
  width: 100% !important;
  height: 100% !important;
  margin: 0 !important;
  padding: 0 !important;
}
</style>
