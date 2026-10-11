// Settings → Launcher: the websites and apps of the island's launcher tab
// (views/launcher.ts). An entry is a name and a web address, or the full path
// of an app, a shortcut, a folder or a file.

import type { LauncherItem, Settings } from "../core/state";
import { clear, h } from "../views/dom";
import { t } from "../i18n/i18n";

/** As many as launcher.rs keeps room for. */
export const MAX_ITEMS = 24;

export const isWeb = (target: string): boolean => /^https?:\/\/\S+\.\S+/i.test(target);
/** A full path: `C:\…`, `\\server\…` or `/…`. Whether it exists is the app's to find out. */
export const isPath = (target: string): boolean => /^([a-z]:[\\/]|\\\\|\/)/i.test(target);

/** An installed app, as the "add" window's search names it (launcher.rs, is_app). */
export const isApp = (target: string): boolean => /^shell:AppsFolder\\[^"<>|*?\x00-\x1f]+$/i.test(target);

/** The apps whose name holds every word typed, those that start with it first. */
export function matchingApps<T extends { name: string }>(apps: readonly T[], typed: string): T[] {
  const words = typed.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...apps];
  const found = apps.filter((app) => {
    const name = app.name.toLowerCase();
    return words.every((word) => name.includes(word));
  });
  const first = (app: T) => (app.name.toLowerCase().startsWith(words[0]) ? 0 : 1);
  return found.sort((a, b) => first(a) - first(b));
}

/** What to call an entry the user gave no name: the site, or the file without its extension. */
export function defaultName(target: string): string {
  if (isWeb(target)) {
    try {
      return new URL(target).hostname.replace(/^www\./, "");
    } catch {
      return target;
    }
  }
  const last = target.split(/[\\/]/).filter((part) => part).pop() ?? target;
  return last.replace(/\.(exe|lnk|url|bat|cmd)$/i, "");
}

/**
 * `current` hands over the settings in force when it is called: the window
 * swaps the object for a fresh one whenever a change comes in from elsewhere.
 */
export function launcherSection(current: () => Settings, save: () => Promise<void>): HTMLElement {
  const list = h("div", { class: "launch-list" });
  const note = h("div", { class: "notice err", style: "display:none" });
  const name = h("input", { type: "text", placeholder: t("Name"), style: "width:150px" }) as HTMLInputElement;
  const target = h("input", {
    type: "text", placeholder: t("Web address or full path"), style: "flex:1 1 220px;min-width:0",
  }) as HTMLInputElement;
  const add = h("button", { class: "primary", text: t("Add") }) as HTMLButtonElement;

  const items = (): LauncherItem[] => current().launcher ?? [];
  const commit = (next: LauncherItem[]) => {
    current().launcher = next;
    void save();
    draw();
  };

  function draw() {
    clear(list);
    items().forEach((item, index) => {
      list.append(h(
        "div",
        { class: "row" },
        h("span", { style: "font-size:12.5px;min-width:132px", text: item.name }),
        h("span", {
          class: "path",
          style: "flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap",
          text: item.target,
          title: item.target,
        }),
        h("button", {
          class: "danger",
          text: t("Remove"),
          onclick: () => commit(items().filter((_, i) => i !== index)),
        }),
      ));
    });
    add.disabled = items().length >= MAX_ITEMS;
  }

  function submit() {
    if (items().length >= MAX_ITEMS) return;
    // A path copied from the file manager comes in quotes.
    const where = target.value.trim().replace(/^"(.*)"$/, "$1");
    if (!isWeb(where) && !isPath(where) && !isApp(where)) {
      note.textContent = t("Enter a web address (https://…) or the full path of a file or folder.");
      note.style.display = "";
      return;
    }
    note.style.display = "none";
    commit([...items(), { name: name.value.trim() || defaultName(where), target: where }]);
    name.value = "";
    target.value = "";
  }
  add.addEventListener("click", submit);
  for (const field of [name, target]) {
    field.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
  }

  draw();
  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: t("Launcher") })),
    h("div", {
      class: "hint",
      text: t("Open websites and apps from the island's fourth tab. Add a web address, or the full path of an app, a shortcut or a folder."),
    }),
    list,
    h("div", { class: "row" }, name, target, add),
    note,
  );
}
