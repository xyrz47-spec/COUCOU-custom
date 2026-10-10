// The launcher's "add" window: a small form of its own, opened from the
// launcher tab's + tile (views/launcher.ts). One entry is added to the saved
// list and the window goes away; Settings → Launcher still lists and removes.
//
// From top to bottom: the name, the web address or path, and — only if wanted —
// an image file of the user's own for the tile to wear instead of the entry's
// icon.
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

/** The files launcher.rs will show as a tile's picture. */
const isImageFile = (path: string): boolean => /\.(png|jpe?g|gif|webp|ico|svg|bmp)$/i.test(path);

async function applyLanguage() {
  const boot = await Bridge.boot();
  setLanguage(resolveLanguage(boot?.settings.language ?? "", systemLanguages()));
  document.documentElement.dir = isRtl() ? "rtl" : "ltr";
  document.title = t("Add to the launcher");
}

/** The window was just shown: its content fades in and settles (settings.css). */
function appear() {
  root.classList.remove("appear");
  void root.offsetWidth;
  root.classList.add("appear");
}

function draw() {
  const name = h("input", { type: "text", placeholder: t("Name") }) as HTMLInputElement;
  const target = h("input", { type: "text", placeholder: t("Web address or full path") }) as HTMLInputElement;
  const image = h("input", { type: "text", placeholder: t("Image file (optional)") }) as HTMLInputElement;
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
      target.focus();
      return;
    }
    const picture = unquoted(image.value);
    add.disabled = true;
    try {
      // The list as it is saved now: it may have changed since this window was last shown.
      const boot = await Bridge.boot();
      if (!boot) return;
      const list = boot.settings.launcher ?? [];
      if (list.length < MAX_ITEMS) {
        const entry = { name: name.value.trim() || defaultName(where), target: where };
        await Bridge.saveSettings({
          ...boot.settings,
          launcher: [...list, isPath(picture) ? { ...entry, image: picture } : entry],
        });
      }
      void Bridge.closeLauncherAdd();
    } finally {
      add.disabled = false;
    }
  }

  add.addEventListener("click", () => void submit());
  for (const field of [name, target, image]) {
    field.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void submit();
    });
  }

  clear(root);
  root.append(h(
    "section",
    { class: "add-form" },
    h("h2", {}, h("span", { text: t("Add to the launcher") })),
    name,
    target,
    image,
    h("div", {
      class: "hint",
      text: `${t("Drop an app, a shortcut or a folder here, or type a web address or a full path.")} ${t("Drop an image to use it as the tile's picture.")}`,
    }),
    note,
    h("div", { class: "row" }, h("span", { class: "spacer" }), cancel, add),
  ));
  name.focus();

  return {
    /**
     * A file dropped on the window. An image is the tile's picture, unless
     * nothing is to be opened yet and it lands on nothing in particular: then
     * anything else is what the tile opens.
     */
    dropped(path: string) {
      note.style.display = "none";
      if (isImageFile(path) && target.value.trim()) {
        image.value = path;
        return;
      }
      if (isImageFile(path) && document.activeElement === image) {
        image.value = path;
        return;
      }
      target.value = path;
      if (!name.value.trim()) name.value = defaultName(path);
    },
  };
}

async function main() {
  await applyLanguage();
  let form = draw();
  appear();

  // Shown again: an empty form, in the language of the moment.
  void onEvent<null>("launcher-add-open", () => {
    void applyLanguage().then(() => {
      form = draw();
      appear();
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
      // No drops here: the paths can still be typed or pasted.
    }
  }
}

void main();
