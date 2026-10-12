// Decide view — the island's fifth tab: "what should I eat / drink / do?"
// Say how you feel, list a few options (or fill them from a preset), press
// Decide, and JEV ranks them (src-tauri/src/jev.rs). It picks among your
// options; it makes none up. It needs the TypeSafe key of Settings → JEV, and
// sends the feeling and the options only when Decide is pressed.
//
// Two parts can be switched off in Settings → Features: the presets, and the
// memory of the last options (kept in this window's storage, nowhere else).
//
// It reuses the skills tab's look (style.css, .sk-*): no new style.

import { Bridge, type JevDecision } from "../core/bridge";
import { featureOn } from "../core/features";
import { PRESETS, doubt, parseOptions, presetText, rows } from "../core/jev";
import { State } from "../core/state";
import { clear, h } from "./dom";
import type { ViewActions, ViewHost } from "./views";
import { t, tl } from "../i18n/i18n";

const MEMORY_KEY = "coucou.decideOptions";

function remembered(): string {
  try {
    return window.localStorage?.getItem(MEMORY_KEY) ?? "";
  } catch {
    return "";
  }
}

function remember(text: string) {
  try {
    if (text) window.localStorage?.setItem(MEMORY_KEY, text);
    else window.localStorage?.removeItem(MEMORY_KEY);
  } catch {
    // Storage off: the options are simply not kept.
  }
}

export function buildDecide(actions: ViewActions): ViewHost {
  let decision: JevDecision | null = null;
  let busy = false;
  let error = "";

  const feeling = h("input", { type: "text", class: "sk-search", placeholder: tl("How do you feel? (tired, want something warm…)"), maxlength: "200" }) as HTMLInputElement;
  const options = h("textarea", {
    class: "sk-search",
    placeholder: tl("Options, one per line"),
    style: "width:100%;height:76px;resize:none;box-sizing:border-box",
  }) as HTMLTextAreaElement;
  const presets = h("div", { class: "sk-chips" });
  const go = h("button", { class: "sk-btn primary", onclick: () => void run() }) as HTMLButtonElement;
  const note = h("div", { class: "sk-note" });
  const list = h("div", { class: "sk-list" });
  const el: HTMLElement = h(
    "div",
    { class: "view skills decide" },
    h("div", { class: "card" }, feeling, options, h("div", { class: "sk-bar" }, presets, go), note, list),
  );

  PRESETS.forEach((preset, index) => {
    presets.append(h("button", {
      class: "sk-chip",
      text: tl(preset.label),
      onclick: () => {
        actions.blip();
        options.value = presetText(index);
        decision = null;
        draw();
      },
    }));
  });

  function draw() {
    // Settings → Features → "Presets": the chips are there while it is on.
    presets.style.display = featureOn(State.settings, "decidePresets") ? "" : "none";
    go.disabled = busy;
    go.textContent = busy ? t("Asking JEV…") : t("Decide");
    note.textContent = error;
    note.classList.toggle("err", error !== "");
    note.style.display = error ? "" : "none";
    clear(list);
    if (decision) {
      for (const row of rows(decision)) {
        list.append(h(
          "div",
          { class: "sk-row" },
          h(
            "div",
            { class: "sk-text" },
            h("div", { class: "sk-name" }, h("span", { text: row.option }), h("span", { class: row.best ? "sk-tag ok" : "sk-tag", text: row.share })),
            h("div", { style: `height:4px;border-radius:2px;margin-top:4px;width:${row.width}%;background:currentColor;opacity:${row.best ? 0.7 : 0.25}` }),
          ),
        ));
      }
      const unsure = doubt(decision);
      if (unsure) list.append(h("div", { class: "sk-desc", text: unsure }));
    } else if (!busy && !error) {
      list.append(h("div", { class: "sk-empty", text: t("List a few options and press Decide: JEV ranks them for how you feel.") }));
    }
  }

  async function run() {
    const chosen = parseOptions(options.value);
    if (busy) return;
    if (chosen.length < 2) {
      error = t("Give at least 2 different options.");
      decision = null;
      draw();
      return;
    }
    actions.blip();
    busy = true;
    error = "";
    draw();
    try {
      decision = (await Bridge.jevDecide(feeling.value, chosen)) ?? null;
      if (featureOn(State.settings, "decideRemember")) remember(options.value.trim());
    } catch (err) {
      decision = null;
      error = String(err).replace(/^Error:\s*/, "");
    }
    busy = false;
    draw();
  }

  for (const field of [feeling, options]) {
    field.addEventListener("keydown", (e) => {
      const key = e as KeyboardEvent;
      if (key.key === "Enter" && (field === feeling || key.ctrlKey || key.metaKey)) void run();
    });
  }

  draw();
  let here = false;
  return {
    el,
    focus() {
      (options.value ? feeling : options).focus();
    },
    sync() {
      const now = State.view === "decide";
      if (now && !here) {
        // The last options come back, if the memory is on; the feeling is never kept.
        if (!options.value && featureOn(State.settings, "decideRemember")) options.value = remembered();
        if (!featureOn(State.settings, "decideRemember")) remember("");
      }
      if (!now && here) {
        feeling.value = "";
        decision = null;
        error = "";
      }
      here = now;
      draw();
    },
  };
}
