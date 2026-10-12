// Menu view — the island's sixth tab: say how you feel like eating, get about
// five dishes back (src-tauri/src/menu.rs). The question goes to the chat
// provider of Settings → Chat, or the one picked in Settings → Menu (a JEV
// server goes in as the Custom server); the line under the field says which,
// and whether what is typed leaves this PC. "Again" asks for others.
//
// It reuses the skills tab's look (style.css, .sk-*): no new style.

import { Bridge, type MenuItem, type MenuProviderInfo } from "../core/bridge";
import { providerDef } from "../core/providers";
import { State } from "../core/state";
import { clear, h } from "./dom";
import type { ViewActions, ViewHost } from "./views";
import { t } from "../i18n/i18n";

/** The names already shown, newest last, without repeats: sent back so "Again" gives others. */
export function namesToAvoid(shown: readonly string[], items: readonly MenuItem[], max = 20): string[] {
  const all = [...shown];
  for (const item of items) if (!all.some((n) => n.toLowerCase() === item.name.toLowerCase())) all.push(item.name);
  return all.slice(-max);
}

export function buildMenu(actions: ViewActions): ViewHost {
  let items: MenuItem[] = [];
  let shown: string[] = [];
  let busy = false;
  let error = "";
  let provider: MenuProviderInfo | null = null;
  let lastMood = "";

  const input = h("input", { type: "text", class: "sk-search", placeholder: t("What do you feel like eating?"), maxlength: "300" }) as HTMLInputElement;
  const ask = h("button", { class: "sk-btn primary", text: t("Recommend"), onclick: () => void run(false) }) as HTMLButtonElement;
  const again = h("button", { class: "sk-btn", text: t("Again"), onclick: () => void run(true) }) as HTMLButtonElement;
  const note = h("div", { class: "sk-note" });
  const list = h("div", { class: "sk-list" });
  const el: HTMLElement = h(
    "div",
    { class: "view skills menu" },
    h("div", { class: "card" }, h("div", { class: "sk-top" }, input, ask, again), note, list),
  );

  function providerLine(): string {
    if (!provider) return "";
    const name = providerDef(provider.provider).name;
    return t("{name} · {where}", {
      name: provider.model ? `${name} (${provider.model})` : name,
      where: provider.external ? t("what you type is sent to it") : t("stays on this PC"),
    });
  }

  function draw() {
    ask.disabled = busy;
    again.disabled = busy || items.length === 0;
    ask.textContent = busy ? t("Thinking…") : t("Recommend");
    note.textContent = error || providerLine();
    note.classList.toggle("err", error !== "");
    note.style.display = note.textContent ? "" : "none";
    clear(list);
    for (const item of items) {
      list.append(h(
        "div",
        { class: "sk-row" },
        h(
          "div",
          { class: "sk-text" },
          h("div", { class: "sk-name" }, h("span", { text: item.name }), ...item.tags.map((tag) => h("span", { class: "sk-tag", text: tag }))),
          h("div", { class: "sk-desc", text: item.why, title: item.why }),
        ),
      ));
    }
    if (items.length === 0 && !busy) list.append(h("div", { class: "sk-empty", text: t("Say how you feel, and get about five ideas.") }));
  }

  async function run(more: boolean) {
    const mood = more ? lastMood : input.value.trim();
    if (!mood || busy) return;
    actions.blip();
    busy = true;
    error = "";
    lastMood = mood;
    if (!more) shown = [];
    draw();
    try {
      const got = await Bridge.menuRecommend(mood, shown);
      items = got ?? [];
      shown = namesToAvoid(shown, items);
    } catch (err) {
      error = String(err).replace(/^Error:\s*/, "");
    }
    busy = false;
    draw();
  }

  input.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") void run(false);
  });

  let here = false;
  return {
    el,
    focus() {
      input.focus();
    },
    sync() {
      const now = State.view === "menu";
      if (now && !here) {
        // Who answers, read again whenever the tab comes into view (Settings may have changed it).
        void Bridge.menuProvider().then((info) => {
          provider = info ?? null;
          draw();
        });
      }
      here = now;
    },
  };
}
