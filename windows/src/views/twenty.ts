// Twenty questions — the island's sixth tab. Coucou thinks of an animal, a
// food or an object and keeps it to itself (src-tauri/src/twenty.rs); you ask
// yes/no questions, up to twenty, and JEV answers each one. When you think you
// know, "I know it!" turns the box into a guess — it costs a question too — and
// a right one wins. The secret is only told when the game is over.
//
// It needs the TypeSafe key of Settings → JEV; each question sends the secret's
// name and your question to JEV, nothing else. It reuses the skills tab's look
// (style.css, .sk-*): no new style.

import { Bridge, type TwentyLabel, type TwentySecret } from "../core/bridge";
import { KINDS, answerText, progress, secretText } from "../core/twenty";
import { clear, h } from "./dom";
import type { ViewActions, ViewHost } from "./views";
import { t, tl } from "../i18n/i18n";

interface Turn {
  text: string;
  /** A question's answer, or a guess that was wrong. */
  label: TwentyLabel | "wrongGuess";
}

export function buildTwenty(actions: ViewActions): ViewHost {
  let phase: "start" | "play" | "over" = "start";
  let guessing = false;
  let busy = false;
  let error = "";
  let asked = 0;
  let total = 20;
  let turns: Turn[] = [];
  /** How the game ended: won in this many questions, or the secret that was missed. */
  let ending: { won: boolean; asked: number; secret: TwentySecret | null } | null = null;
  let pool = 0;

  const input = h("input", { type: "text", class: "sk-search", maxlength: "200" }) as HTMLInputElement;
  const send = h("button", { class: "sk-btn primary", onclick: () => void submit() }) as HTMLButtonElement;
  const guess = h("button", { class: "sk-btn", onclick: () => { guessing = !guessing; draw(); input.focus(); } }) as HTMLButtonElement;
  const giveUp = h("button", { class: "sk-btn danger", text: t("Give up"), onclick: () => void quit() }) as HTMLButtonElement;
  const again = h("button", { class: "sk-btn primary", text: t("New game"), onclick: () => { phase = "start"; error = ""; draw(); } });
  const count = h("span", { class: "sk-count" });
  const kinds = h("div", { class: "sk-chips" });
  const note = h("div", { class: "sk-note" });
  const list = h("div", { class: "sk-list" });
  const play = h("div", { class: "sk-top" }, input, send);
  const bar = h("div", { class: "sk-bar" }, count, guess, giveUp);
  const el: HTMLElement = h("div", { class: "view skills twenty" }, h("div", { class: "card" }, kinds, play, bar, note, list));

  for (const kind of KINDS) {
    kinds.append(h("button", { class: "sk-chip", text: tl(kind.label), onclick: () => void start(kind.id) }));
  }

  function draw() {
    kinds.style.display = phase === "start" ? "" : "none";
    play.style.display = phase === "play" ? "" : "none";
    bar.style.display = phase === "play" ? "" : "none";
    note.textContent = error;
    note.classList.toggle("err", error !== "");
    note.style.display = error ? "" : "none";
    send.disabled = busy;
    send.textContent = busy ? t("Asking JEV…") : guessing ? t("Guess") : t("Ask");
    guess.textContent = guessing ? t("Back to questions") : t("I know it!");
    input.placeholder = guessing ? t("What is it?") : t("Ask a yes/no question…");
    count.textContent = phase === "play" ? progress(asked, total) : "";
    clear(list);
    if (phase === "start") {
      list.append(h("div", { class: "sk-empty", text: t("I am thinking of something. What kind?") }));
      return;
    }
    if (phase === "over" && ending) {
      list.append(h(
        "div",
        { class: "sk-row" },
        h("div", { class: "sk-text" },
          h("div", { class: "sk-name" }, h("span", { text: ending.won ? t("You got it in {n} questions!", { n: ending.asked }) : t("It was: {name}", { name: ending.secret ? secretText(ending.secret) : "?" }) })),
          h("div", { class: "sk-desc", text: ending.won && ending.secret ? secretText(ending.secret) : t("Better luck next time.") }),
        ),
        again,
      ));
    }
    if (phase === "play" && pool > 0) list.append(h("div", { class: "sk-desc", text: t("I am thinking of one of {n} things.", { n: pool }) }));
    for (const turn of [...turns].reverse()) {
      const shown = turn.label === "wrongGuess" ? { text: t("Wrong guess"), mood: "bad" as const } : answerText(turn.label);
      list.append(h(
        "div",
        { class: "sk-row" },
        h("div", { class: "sk-text" },
          h("div", { class: "sk-name" }, h("span", { text: turn.text }), h("span", { class: `sk-tag ${shown.mood}`.trim(), text: shown.text })),
        ),
      ));
    }
  }

  async function start(kind: string) {
    actions.blip();
    error = "";
    try {
      const started = await Bridge.twentyNew(kind);
      total = started?.total ?? 20;
      pool = started?.pool ?? 0;
      asked = 0;
      turns = [];
      ending = null;
      guessing = false;
      phase = "play";
      input.value = "";
    } catch (err) {
      error = String(err).replace(/^Error:\s*/, "");
    }
    draw();
    if (phase === "play") input.focus();
  }

  async function submit() {
    const text = input.value.trim();
    if (!text || busy || phase !== "play") return;
    actions.blip();
    busy = true;
    error = "";
    draw();
    try {
      if (guessing) {
        const result = await Bridge.twentyGuess(text);
        asked = result.asked;
        if (result.correct) {
          ending = { won: true, asked: result.asked, secret: result.secret };
          phase = "over";
        } else {
          turns.push({ text, label: "wrongGuess" });
          if (result.over) {
            ending = { won: false, asked: result.asked, secret: result.secret };
            phase = "over";
          }
        }
        guessing = false;
      } else {
        const result = await Bridge.twentyAsk(text);
        asked = result.asked;
        turns.push({ text, label: result.label });
        if (result.over) {
          ending = { won: false, asked: result.asked, secret: result.secret };
          phase = "over";
        }
      }
      input.value = "";
    } catch (err) {
      error = String(err).replace(/^Error:\s*/, "");
    }
    busy = false;
    draw();
    if (phase === "play") input.focus();
  }

  async function quit() {
    if (phase !== "play") return;
    actions.blip();
    try {
      const secret = await Bridge.twentyGiveUp();
      ending = { won: false, asked, secret };
      phase = "over";
    } catch (err) {
      error = String(err).replace(/^Error:\s*/, "");
    }
    draw();
  }

  input.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") void submit();
  });

  draw();
  return {
    el,
    focus() {
      if (phase === "play") input.focus();
    },
    sync() {
      // The game stays while another tab is open: the secret is in Rust, and the answers are only on this page.
    },
  };
}
