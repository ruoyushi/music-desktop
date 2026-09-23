/** 多窗口管理：迷你播放器 / 桌面歌词 */

import { invoke } from "@tauri-apps/api/core";

/** 显示并聚焦主窗口（关闭到托盘后可从此恢复） */
export async function openMainWindow() {
  try {
    const { getAllWebviewWindows } = await import(
      "@tauri-apps/api/webviewWindow"
    );
    const main = (await getAllWebviewWindows()).find((w) => w.label === "main");
    if (!main) return null;
    await main.show();
    await main.unminimize();
    await main.setFocus();
    return main;
  } catch (e) {
    console.warn("openMainWindow failed", e);
    return null;
  }
}

export async function openMiniPlayer() {
  try {
    const { WebviewWindow, getAllWebviewWindows } = await import(
      "@tauri-apps/api/webviewWindow"
    );
    const existing = (await getAllWebviewWindows()).find((w) => w.label === "mini");
    if (existing) {
      await existing.show();
      await existing.setFocus();
      return existing;
    }
    const win = new WebviewWindow("mini", {
      url: "/#/mini",
      title: "迷你播放器",
      width: 360,
      height: 88,
      decorations: false,
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      transparent: false,
      center: false,
      x: 40,
      y: 40,
    });
    return win;
  } catch (e) {
    console.warn("openMiniPlayer failed", e);
    return null;
  }
}

export async function openDesktopLyric() {
  try {
    await invoke("open_desktop_lyric");
  } catch (e) {
    console.warn("openDesktopLyric failed", e);
    return null;
  }
}

/** 独立主题选择窗口 */
export async function openThemePicker() {
  try {
    const { WebviewWindow, getAllWebviewWindows } = await import(
      "@tauri-apps/api/webviewWindow"
    );
    const existing = (await getAllWebviewWindows()).find((w) => w.label === "theme");
    if (existing) {
      await existing.show();
      await existing.unminimize();
      await existing.setFocus();
      return existing;
    }
    const win = new WebviewWindow("theme", {
      url: "/#/theme",
      title: "主题皮肤",
      width: 720,
      height: 560,
      minWidth: 560,
      minHeight: 420,
      decorations: false,
      resizable: true,
      center: true,
      transparent: false,
    });
    return win;
  } catch (e) {
    console.warn("openThemePicker failed", e);
    return null;
  }
}

/** 独立设置窗口 */
export async function openSettingsWindow() {
  try {
    const { WebviewWindow, getAllWebviewWindows } = await import(
      "@tauri-apps/api/webviewWindow"
    );
    const existing = (await getAllWebviewWindows()).find(
      (w) => w.label === "settings",
    );
    if (existing) {
      await existing.show();
      await existing.unminimize();
      await existing.setFocus();
      return existing;
    }
    const win = new WebviewWindow("settings", {
      url: "/#/settings",
      title: "设置",
      width: 640,
      height: 520,
      minWidth: 520,
      minHeight: 400,
      decorations: false,
      resizable: true,
      center: true,
      transparent: false,
    });
    return win;
  } catch (e) {
    console.warn("openSettingsWindow failed", e);
    return null;
  }
}

export async function closeWindowByLabel(label: string) {
  try {
    const { getAllWebviewWindows } = await import("@tauri-apps/api/webviewWindow");
    const win = (await getAllWebviewWindows()).find((w) => w.label === label);
    if (win) await win.close();
  } catch {
    // ignore
  }
}
