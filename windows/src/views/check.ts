// Check view — the island's fifth tab: paste a message you got, or one you are
// about to send, and JEV reads it (src-tauri/src/jev.rs): how it sounds, how
// urgent it is, whether it needs a reply, whether it could sound rude. Four
// short lines, no text written for you. It needs the TypeSafe key of
// Settings → JEV; the text pasted is sent only when Check is pressed.
//
// It reuses the skills tab's look (style.css, .sk-*): no new style.

import { Bridge, type JevMessageRead } from "../core/bridge";
import { describe, type ReadLine } from "../core/jev";
import { State } from "../core/state";
import { clear, h } from "./dom";
import type { ViewActions, ViewHost } from "./views";
import { t } from "../i18n/i18n";

const MOODS: Record<ReadLine["mood"], string> = { good: "ok", watch: "", warn: "bad" };

export function buildCheck(actions: ViewActions): ViewHost {
  let read: JevMessageRead | null = null;
  let busy = false;
  let error = "";

  const box = h("textarea", {
    class: "sk-search",
    placeholder: t("Paste a message to check"),
    maxlength: "3000",
    style: "width:100%;height:96px;resize:none;box-sizing:border-box",
  }) as HTMLTextAreaElement;
  const go = h("button", { class: "sk-btn primary", onclick: () => void run() }) as HTMLButtonElement;
  const wipe = h("button", { class: "sk-btn", text: t("Clear"), onclick: () => { box.value = ""; read = null; error = ""; draw(); box.focus(); } });
  const note = h("div", { class: "sk-note" });
  const list = h("div", { class: "sk-list" });
  const el: HTMLElement = h(
    "div",
    { class: "view skills check" },
    h("div", { class: "card" }, box, h("div", { class: "sk-bar" }, go, wipe), note, list),
  );

  function draw() {
    go.disabled = busy;
    go.textContent = busy ? t("Reading…") : t("Check");
    note.textContent = error;
    note.classList.toggle("err", error !== "");
    note.style.display = error ? "" : "none";
    clear(list);
    if (read) {
      for (const line of describe(read)) {
        list.append(h(
          "div",
          { class: "sk-row" },
          h("div", { class: "sk-text" },
            h("div", { class: "sk-name" }, h("span", { text: line.label }), h("span", { class: `sk-tag ${MOODS[line.mood]}`.trim(), text: line.value })),
          ),
        ));
      }
    } else if (!busy && !error) {
      list.append(h("div", { class: "sk-empty", text: t("Paste a message, press Check: how it sounds, how urgent, whether it needs a reply.") }));
    }
  }

  async function run() {
    const text = box.value.trim();
    if (!text || busy) return;
    actions.blip();
    busy = true;
    error = "";
    draw();
    try {
      read = (await Bridge.jevCheckMessage(text)) ?? null;
    } catch (err) {
      read = null;
      error = String(err).replace(/^Error:\s*/, "");
    }
    busy = false;
    draw();
  }

  box.addEventListener("keydown", (e) => {
    const key = e as KeyboardEvent;
    if (key.key === "Enter" && (key.ctrlKey || key.metaKey)) void run();
  });

  draw();
  return {
    el,
    focus() {
      box.focus();
    },
    sync() {
      // Nothing is kept once the tab is left: a message is not stored anywhere.
      if (State.view !== "check" && (box.value || read)) {
        box.value = "";
        read = null;
        error = "";
        draw();
      }
    },
  };
}
