// Launcher view — the island's fourth tab: the websites and apps listed in
// Settings → Launcher as a row of large tiles, one click each
// (src-tauri/src/launcher.rs). An app wears its own icon; a website, which has
// none here (the page loads no image from the network), its initial on a
// colour of its own.

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
  const row = h("div", { class: "launch-row" });
  const empty = h(
    "div",
    { class: "launch-empty" },
    h("span", { text: tl("Add websites and apps in Settings.") }),
    h("button", { class: "link-btn", text: tl("Open Settings"), onclick: () => actions.openSettingsWindow() }),
  );
  const el = h("div", { class: "view launcher" }, row, empty);
  // The row runs sideways: the wheel moves along it.
  row.addEventListener("wheel", (e) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    row.scrollLeft += e.deltaY;
    e.preventDefault();
  }, { passive: false });

  let shown = "";

  function tile(item: LauncherItem, index: number): HTMLElement {
    const art = h("div", { class: "launch-art" }, h("span", { text: tileInitial(item) }));
    const hue = tileHue(item.target);
    art.style.background = `linear-gradient(145deg, hsl(${hue} 62% 46%), hsl(${(hue + 40) % 360} 58% 30%))`;
    if (!isWebTarget(item.target)) {
      void Bridge.launcherIcon(index).then((icon) => {
        const canvas = icon ? iconCanvas(icon) : null;
        if (!canvas) return;
        clear(art);
        art.classList.add("has-icon");
        art.style.background = "";
        art.append(canvas);
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
      clear(row);
      items.forEach((item, index) => row.append(tile(item, index)));
      if (items.length > 0) {
        row.append(h(
          "button",
          { class: "launch-tile add", title: tl("Open Settings"), onclick: () => actions.openSettingsWindow() },
          h("div", { class: "launch-art" }, svg(ICONS.plus, 22)),
          h("span", { class: "launch-name", text: tl("Add") }),
        ));
      }
      row.style.display = items.length > 0 ? "" : "none";
      empty.style.display = items.length > 0 ? "none" : "";
    },
  };
}
