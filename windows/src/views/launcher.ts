// Launcher view — the island's fourth tab: the websites and apps listed in
// Settings → Launcher as tiles in two rows that run sideways, one click each
// (src-tauri/src/launcher.rs). A tile wears its entry's own icon: an app's
// from the system, a website's from that website (kept once fetched, so the
// site is asked one time). Until it comes, or when there is none, the tile
// shows a mini Mochi in a colour of the entry's own, as a pill does.

import { Bridge } from "../core/bridge";
import { State, type AgentTask, type LauncherItem } from "../core/state";
import { createMiniBot, pruneMiniBots, releaseMiniBot } from "../mochi/minibots";
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

/** The entry's colour as "#RRGGBB": the mini Mochi of a tile without an icon wears it. */
export function tileColor(text: string): string {
  const h = tileHue(text) / 360;
  const s = 0.62;
  const l = 0.58;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    t = (t + 1) % 1;
    const v = t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
    return Math.round(v * 255).toString(16).padStart(2, "0");
  };
  return `#${channel(h + 1 / 3)}${channel(h)}${channel(h - 1 / 3)}`;
}

/** What a mini Mochi is made from: a pill's task, with only a colour to it. */
function tilePill(item: LauncherItem): AgentTask {
  return {
    id: `launcher:${item.target}`,
    name: item.name,
    color: tileColor(item.target),
    state: "idle",
    stepIndex: 0,
    steps: [],
    source: "agent",
    isIntegration: false,
  };
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
    h("button", { class: "link-btn", text: tl("Add"), onclick: () => void Bridge.openLauncherAdd() }),
  );
  // One card, like the overview's left one: Mochi stands in its left part.
  const el = h("div", { class: "view launcher" }, h("div", { class: "card" }, grid, empty));
  // The rows run sideways: the wheel moves along them.
  grid.addEventListener("wheel", (e) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    grid.scrollLeft += e.deltaY;
    e.preventDefault();
  }, { passive: false });

  let shown = "";

  function tile(item: LauncherItem, index: number): HTMLElement {
    // A mini Mochi until the icon comes, and for good when there is none.
    // Under the pointer he dances; an icon hops instead (style.css).
    let hovered = false;
    const pill = createMiniBot(tilePill(item), 32, () => hovered);
    const art = h("div", { class: "launch-art mochi" }, pill);
    const wear = (picture: HTMLElement) => {
      const canvas = pill.querySelector("canvas");
      if (canvas) releaseMiniBot(canvas);
      clear(art);
      art.classList.remove("mochi");
      art.classList.add("has-icon");
      art.append(picture);
    };
    /** The entry's own icon: a website's from the website, a file's from the system. */
    const ownIcon = () => {
      if (isWebTarget(item.target)) {
        void siteIcon(item.target, index).then((data) => {
          if (!data) return;
          const img = h("img", { alt: "", draggable: "false" }) as HTMLImageElement;
          // An icon that will not draw leaves the mini Mochi in place.
          img.addEventListener("load", () => wear(img));
          img.src = data;
        });
      } else {
        void Bridge.launcherIcon(index).then((icon) => {
          const canvas = icon ? iconCanvas(icon) : null;
          if (canvas) wear(canvas);
        });
      }
    };
    if (item.image) {
      // A picture of the user's own comes first; one that cannot be shown gives way to the icon.
      void Bridge.launcherImage(index).then((data) => {
        if (!data) return ownIcon();
        const img = h("img", { alt: "", draggable: "false" }) as HTMLImageElement;
        img.addEventListener("load", () => {
          wear(img);
          art.classList.add("custom");
        });
        img.addEventListener("error", ownIcon);
        img.src = data;
      });
    } else {
      ownIcon();
    }
    const button = h(
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
    // The colour the tile lights up in under the pointer, as "r, g, b".
    const colour = parseInt(tileColor(item.target).slice(1), 16);
    button.style.setProperty("--tile", `${(colour >> 16) & 255}, ${(colour >> 8) & 255}, ${colour & 255}`);
    button.addEventListener("mouseenter", () => {
      hovered = true;
    });
    button.addEventListener("mouseleave", () => {
      hovered = false;
    });
    return button;
  }

  return {
    el,
    sync() {
      const items = State.settings.launcher ?? [];
      const key = JSON.stringify(items);
      if (key === shown) return;
      shown = key;
      clear(grid);
      // The mini Mochis of the tiles just taken down are let go with them.
      pruneMiniBots();
      items.forEach((item, index) => grid.append(tile(item, index)));
      if (items.length > 0) {
        grid.append(h(
          "button",
          { class: "launch-tile add", title: tl("Add to the launcher"), onclick: () => void Bridge.openLauncherAdd() },
          h("div", { class: "launch-art" }, svg(ICONS.plus, 16)),
          h("span", { class: "launch-name", text: tl("Add") }),
        ));
      }
      grid.style.display = items.length > 0 ? "" : "none";
      empty.style.display = items.length > 0 ? "none" : "";
    },
  };
}
