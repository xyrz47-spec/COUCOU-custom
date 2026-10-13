// Decide view — the island's fifth tab: "what should I eat / drink / do?"
// Say how you feel, list a few options (or fill them from a preset), press
// Decide, and JEV ranks them (src-tauri/src/jev.rs). It picks among your
// options; it makes none up. It needs the TypeSafe key of Settings → JEV, and
// sends the feeling and the options only when Decide is pressed.
//
// Two parts can be switched off in Settings → Features: the presets, and the
// memory of the last options (kept in this window's storage, nowhere else).
//
// Laid out as two halves (style.css, .dc-*): what you feel and the options on
// the left, with the presets and the button; the ranking on the right, the
// best pick on a card of its own and the others under it, each with its bar.

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

  const feeling = h("input", { type: "text", class: "dc-input", placeholder: tl("How do you feel? (tired, want something warm…)"), maxlength: "200" }) as HTMLInputElement;
  const options = h("textarea", { class: "dc-input dc-options", placeholder: tl("Options, one per line") }) as HTMLTextAreaElement;
  const presets = h("div", { class: "dc-presets" });
  const go = h("button", { class: "dc-go", onclick: () => void run() }) as HTMLButtonElement;
  const note = h("div", { class: "dc-note" });
  const out = h("div", { class: "dc-out" });
  const el: HTMLElement = h(
    "div",
    { class: "view decide" },
    h("div", { class: "card dc" }, h("div", { class: "dc-form" }, feeling, options, presets, go, note), out),
  );

  PRESETS.forEach((preset, index) => {
    presets.append(h("button", {
      class: "dc-preset",
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
    // Settings → Features → "Presets": the capsules are there while it is on.
    presets.style.display = featureOn(State.settings, "decidePresets") ? "" : "none";
    go.disabled = busy;
    go.textContent = busy ? t("Asking JEV…") : t("Decide");
    note.textContent = error;
    note.style.display = error ? "" : "none";
    clear(out);
    if (decision) {
      const [best, ...others] = rows(decision);
      if (best) {
        out.append(h(
          "div",
          { class: "dc-win" },
          h("div", { class: "dc-win-label", text: t("Best pick") }),
          h("div", { class: "dc-win-row" }, h("span", { class: "dc-win-name", text: best.option }), h("span", { class: "dc-win-share", text: best.share })),
          h("div", { class: "dc-bar" }, h("i", { style: `width:${best.width}%` })),
        ));
      }
      const list = h("div", { class: "dc-rank" });
      others.forEach((row, i) => {
        list.append(h(
          "div",
          { class: "dc-row" },
          h("span", { class: "dc-place", text: String(i + 2) }),
          h("span", { class: "dc-name", text: row.option }),
          h("span", { class: "dc-bar small" }, h("i", { style: `width:${row.width}%` })),
          h("span", { class: "dc-share", text: row.share }),
        ));
      });
      out.append(list);
      const unsure = doubt(decision);
      if (unsure) out.append(h("div", { class: "dc-doubt", text: unsure }));
    } else {
      out.append(h("div", { class: "dc-empty", text: busy ? t("Asking JEV…") : t("List a few options and press Decide: JEV ranks them for how you feel.") }));
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
