// The launcher's "add" window: a small form of its own, opened from the
// launcher tab's + tile (views/launcher.ts). One entry is added to the saved
// list and the window goes away; Settings → Launcher still lists and removes.
//
// On the left, a square for the tile's picture; beside it, from top to bottom,
// the name, the web address or path, and the two buttons. The picture is only
// for who wants one — an image file of their own, picked with a click or
// dropped on the window — and without it the tile wears the entry's own icon.
//
// Like the settings window it is made once, hidden, at launch, and only shown
// and hidden afterwards: `launcher-add-open` says it has just been shown.

import "./settings.css";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Bridge, IS_TAURI, onEvent } from "../core/bridge";
import { clear, h, svg } from "../views/dom";
import { ICONS } from "../views/icons";
import { isRtl, resolveLanguage, setLanguage, systemLanguages, t } from "../i18n/i18n";
import { MAX_ITEMS, defaultName, isPath, isWeb } from "./launcher";

const root = document.getElementById("settings-root")!;

/** A path copied from the file manager comes in quotes. */
const unquoted = (text: string): string => text.trim().replace(/^"(.*)"$/, "$1");

/** The files launcher.rs will show as a tile's picture. */
const isImageFile = (path: string): boolean => /\.(png|jpe?g|gif|webp|ico|svg|bmp)$/i.test(path);

/** As large as launcher.rs keeps (IMAGE_LIMIT). */
const IMAGE_LIMIT = 4 * 1024 * 1024;

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
  const add = h("button", { class: "primary", text: t("Add") }) as HTMLButtonElement;
  const cancel = h("button", { text: t("Cancel"), onclick: () => void Bridge.closeLauncherAdd() });

  // ── The picture ─────────────────────────────────────────────────────────────
  // Either a file on disk (dropped: its path is known) or one picked through
  // the file dialog, of which the page only has the bytes: those are handed to
  // launcher.rs when the entry is added, which keeps a copy and says where.
  let picturePath = "";
  let pictureData = "";
  const preview = h("img", { alt: "", draggable: "false" }) as HTMLImageElement;
  const empty = h("div", { class: "add-picture-empty" }, svg(ICONS.plus, 18), h("span", { text: t("Image") }));
  const remove = h("button", { class: "add-picture-remove", title: t("Remove") }, "×") as HTMLButtonElement;
  const picker = h("input", { type: "file", accept: "image/*", style: "display:none" }) as HTMLInputElement;
  const picture = h(
    "div",
    { class: "add-picture", title: t("Drop an image to use it as the tile's picture."), tabindex: "0" },
    empty,
    preview,
    remove,
    picker,
  );

  const showPicture = (src: string) => {
    if (src) preview.setAttribute("src", src);
    else preview.removeAttribute("src");
    picture.classList.toggle("has-picture", !!src);
  };
  const clearPicture = () => {
    picturePath = "";
    pictureData = "";
    picker.value = "";
    showPicture("");
  };
  picture.addEventListener("click", (e) => {
    if (e.target === remove) return;
    picker.click();
  });
  picture.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") picker.click();
  });
  remove.addEventListener("click", clearPicture);
  picker.addEventListener("change", () => {
    const file = picker.files?.[0];
    if (!file || file.size > IMAGE_LIMIT) return;
    const reader = new FileReader();
    reader.onload = () => {
      picturePath = "";
      pictureData = String(reader.result ?? "");
      showPicture(pictureData);
    };
    reader.readAsDataURL(file);
  });

  // ── Adding ──────────────────────────────────────────────────────────────────

  /** The address is not one: its field says so, without the form moving. */
  const refuse = () => {
    target.classList.remove("invalid");
    void target.offsetWidth;
    target.classList.add("invalid");
    target.title = t("Enter a web address (https://…) or the full path of a file or folder.");
    target.focus();
  };
  target.addEventListener("input", () => {
    target.classList.remove("invalid");
    target.title = "";
  });

  async function submit() {
    const where = unquoted(target.value);
    if (!isWeb(where) && !isPath(where)) return refuse();
    add.disabled = true;
    try {
      // The list as it is saved now: it may have changed since this window was last shown.
      const boot = await Bridge.boot();
      if (!boot) return;
      const list = boot.settings.launcher ?? [];
      if (list.length < MAX_ITEMS) {
        const image = pictureData ? ((await Bridge.launcherStoreImage(pictureData)) ?? "") : picturePath;
        const entry = { name: name.value.trim() || defaultName(where), target: where };
        await Bridge.saveSettings({
          ...boot.settings,
          launcher: [...list, image ? { ...entry, image } : entry],
        });
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
    { class: "add-form" },
    picture,
    name,
    target,
    h("div", { class: "add-buttons" }, cancel, add),
  ));
  name.focus();

  return {
    /** A file dropped on the window: an image is the tile's picture, anything else what it opens. */
    dropped(path: string) {
      if (isImageFile(path)) {
        pictureData = "";
        picturePath = path;
        picker.value = "";
        void Bridge.launcherImageAt(path).then((data) => {
          // Still the one wanted, and an image the page can show.
          if (picturePath !== path) return;
          if (data) showPicture(data);
          else clearPicture();
        });
        return;
      }
      target.value = path;
      target.classList.remove("invalid");
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
      // No drops here: the path can still be typed or pasted, the picture picked.
    }
  }
}

void main();
