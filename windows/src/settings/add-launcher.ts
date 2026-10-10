// The launcher's "add" window: a small form of its own, opened from the
// launcher tab's + tile (views/launcher.ts). One entry is added to the saved
// list and the window goes away; Settings → Launcher still lists and removes.
//
// Like the settings window it is made once, hidden, at launch, and only shown
// and hidden afterwards: `launcher-add-open` says it has just been shown.

import "./settings.css";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Bridge, IS_TAURI, onEvent } from "../core/bridge";
import { clear, h } from "../views/dom";
import { isRtl, resolveLanguage, setLanguage, systemLanguages, t } from "../i18n/i18n";
import { MAX_ITEMS, defaultName, isPath, isWeb } from "./launcher";

const root = document.getElementById("settings-root")!;

/** A path copied from the file manager comes in quotes. */
const unquoted = (text: string): string => text.trim().replace(/^"(.*)"$/, "$1");

async function applyLanguage() {
  const boot = await Bridge.boot();
  setLanguage(resolveLanguage(boot?.settings.language ?? "", systemLanguages()));
  document.documentElement.dir = isRtl() ? "rtl" : "ltr";
  document.title = t("Add to the launcher");
}

function draw() {
  const name = h("input", { type: "text", placeholder: t("Name") }) as HTMLInputElement;
  const target = h("input", { type: "text", placeholder: t("Web address or full path") }) as HTMLInputElement;
  const note = h("div", { class: "notice err", style: "display:none" });
  const add = h("button", { class: "primary", text: t("Add") }) as HTMLButtonElement;
  const cancel = h("button", { text: t("Cancel"), onclick: () => void Bridge.closeLauncherAdd() });

  const fail = (text: string) => {
    note.textContent = text;
    note.style.display = "";
  };

  async function submit() {
    const where = unquoted(target.value);
    if (!isWeb(where) && !isPath(where)) {
      fail(t("Enter a web address (https://…) or the full path of a file or folder."));
      return;
    }
    add.disabled = true;
    try {
      // The list as it is saved now: it may have changed since this window was last shown.
      const boot = await Bridge.boot();
      if (!boot) return;
      const list = boot.settings.launcher ?? [];
      if (list.length < MAX_ITEMS) {
        const entry = { name: name.value.trim() || defaultName(where), target: where };
        await Bridge.saveSettings({ ...boot.settings, launcher: [...list, entry] });
      }
      void Bridge.closeLauncherAdd();
    } finally {
      add.disabled = false;
    }
  }

  add.addEventListener("click", () => void submit());
  for (const field of [name, target]) {
    field.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void submit();
    });
  }

  clear(root);
  root.append(h(
    "section",
    {},
    h("h2", {}, h("span", { text: t("Add to the launcher") })),
    h("div", {
      class: "hint",
      text: t("Drop an app, a shortcut or a folder here, or type a web address or a full path."),
    }),
    target,
    name,
    note,
    h("div", { class: "row" }, h("span", { class: "spacer" }), cancel, add),
  ));
  target.focus();

  return {
    /** A file dropped on the window: its path, and its name when none was typed. */
    dropped(path: string) {
      target.value = path;
      if (!name.value.trim()) name.value = defaultName(path);
      note.style.display = "none";
    },
  };
}

async function main() {
  await applyLanguage();
  let form = draw();

  // Shown again: an empty form, in the language of the moment.
  void onEvent<null>("launcher-add-open", () => {
    void applyLanguage().then(() => {
      form = draw();
    });
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") void Bridge.closeLauncherAdd();
  });
  if (IS_TAURI) {
    try {
      void getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type === "drop" && event.payload.paths[0]) form.dropped(event.payload.paths[0]);
      });
    } catch {
      // No drops here: the path can still be typed or pasted.
    }
  }
}

void main();
