// Launcher view — the island's fourth tab: the websites and apps listed in
// Settings → Launcher as tiles in two rows that run sideways, one click each
// (src-tauri/src/launcher.rs). A tile wears its entry's own icon: an app's
// from the system, a website's from that website (kept once fetched, so the
// site is asked one time). Until it comes, or when there is none, the tile
// shows the entry's initial on a colour of its own.

import { Bridge } from "../core/bridge";
import { State, type LauncherItem } from "../core/state";
import { clear, h, svg } from "./dom";
import { ICONS } from "./icons";
import type { ViewActions, ViewHost } from "./views";
import { tl } from "../i18n/i18n";

export const isWebTarget = (target: string): boolean => /^https?:\/\//i.test(target.trim());

/** A colour that is always the same for the same entry. */
export function tileHue(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(hash) % 360;
}

/** The letter a tile without an icon shows: the name's first, else the address's. */
export function tileInitial(item: LauncherItem): string {
  const name = item.name.trim() || item.target.replace(/^https?:\/\/(www\.)?/i, "");
  return ([...name][0] ?? "?").toUpperCase();
}

// ── Website icons, kept ───────────────────────────────────────────────────────

const ICON_KEY = "coucou.launcherIcon:";
/** A data URL larger than this is not kept: storage is small and shared. */
const KEEP_LIMIT = 300_000;
/** Sites already asked in this run, with or without an answer. */
const asked = new Map<string, Promise<string | null>>();

function keptIcon(target: string): string | null {
  try {
    return window.localStorage?.getItem(ICON_KEY + target) ?? null;
  } catch {
    return null;
  }
}

/** The site's icon as a data URL: the one kept, else asked for once per run. */
function siteIcon(target: string, index: number): Promise<string | null> {
  const kept = keptIcon(target);
  if (kept) return Promise.resolve(kept);
  let pending = asked.get(target);
  if (!pending) {
    pending = Bridge.launcherFavicon(index).then((data) => {
      if (data && data.length <= KEEP_LIMIT) {
        try {
          window.localStorage?.setItem(ICON_KEY + target, data);
        } catch {
          // Storage off or full: it is asked for again next run.
        }
      }
      return data ?? null;
    });
    asked.set(target, pending);
  }
  return pending;
}

/** Paints the pixels launcher.rs read from the file's icon. */
function iconCanvas(icon: { width: number; height: number; rgba: string }): HTMLCanvasElement | null {
  try {
    const bytes = Uint8ClampedArray.from(atob(icon.rgba), (c) => c.charCodeAt(0));
    if (bytes.length !== icon.width * icon.height * 4) return null;
    const canvas = document.createElement("canvas");
    canvas.width = icon.width;
    canvas.height = icon.height;
    canvas.getContext("2d")?.putImageData(new ImageData(bytes, icon.width, icon.height), 0, 0);
    return canvas;
  } catch {
    return null;
  }
}

export function buildLauncher(actions: ViewActions): ViewHost {
  const grid = h("div", { class: "launch-grid" });
  const empty = h(
    "div",
    { class: "launch-empty" },
    h("span", { text: tl("Add websites and apps in Settings.") }),
    h("button", { class: "link-btn", text: tl("Open Settings"), onclick: () => actions.openSettingsWindow() }),
  );
  const el = h("div", { class: "view launcher" }, grid, empty);
  // The rows run sideways: the wheel moves along them.
  grid.addEventListener("wheel", (e) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    grid.scrollLeft += e.deltaY;
    e.preventDefault();
  }, { passive: false });

  let shown = "";

  function tile(item: LauncherItem, index: number): HTMLElement {
    const art = h("div", { class: "launch-art" }, h("span", { text: tileInitial(item) }));
    const hue = tileHue(item.target);
    art.style.background = `linear-gradient(145deg, hsl(${hue} 62% 46%), hsl(${(hue + 40) % 360} 58% 30%))`;
    const wear = (picture: HTMLElement) => {
      clear(art);
      art.classList.add("has-icon");
      art.style.background = "";
      art.append(picture);
    };
    if (isWebTarget(item.target)) {
      void siteIcon(item.target, index).then((data) => {
        if (!data) return;
        const img = h("img", { alt: "", draggable: "false" }) as HTMLImageElement;
        // An icon that will not draw leaves the initial in place.
        img.addEventListener("load", () => wear(img));
        img.src = data;
      });
    } else {
      void Bridge.launcherIcon(index).then((icon) => {
        const canvas = icon ? iconCanvas(icon) : null;
        if (canvas) wear(canvas);
      });
    }
    return h(
      "button",
      {
        class: "launch-tile",
        title: item.target,
        onclick: () => {
          actions.blip();
          void Bridge.launcherOpen(index);
        },
      },
      art,
      h("span", { class: "launch-name", text: item.name || item.target }),
    );
  }

  return {
    el,
    sync() {
      const items = State.settings.launcher ?? [];
      const key = JSON.stringify(items);
      if (key === shown) return;
      shown = key;
      clear(grid);
      items.forEach((item, index) => grid.append(tile(item, index)));
      if (items.length > 0) {
        grid.append(h(
          "button",
          { class: "launch-tile add", title: tl("Open Settings"), onclick: () => actions.openSettingsWindow() },
          h("div", { class: "launch-art" }, svg(ICONS.plus, 16)),
          h("span", { class: "launch-name", text: tl("Add") }),
        ));
      }
      grid.style.display = items.length > 0 ? "" : "none";
      empty.style.display = items.length > 0 ? "none" : "";
    },
  };
}
