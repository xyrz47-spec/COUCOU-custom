// Twenty questions — an island tab. Coucou thinks of an animal, a food, a
// Pokémon… and keeps it to itself (src-tauri/src/twenty.rs); you ask yes/no
// questions, up to twenty, and JEV answers each one. When you think you know,
// "I know it!" turns the box into a guess — it costs a question too — and a
// right one wins. The secret is only told when the game is over.
//
// It needs the TypeSafe key of Settings → JEV; each question sends the
// secret's names and facts and your question to JEV, nothing else.
//
// Laid out as a game (style.css, .tq-*): the kinds as capsules to start; then
// a row of twenty dots, one per question, coloured by its answer, the questions
// asked so far as a log, and the box to ask in; at the end, the secret on a
// card of its own.

import { Bridge, type TwentyLabel, type TwentySecret } from "../core/bridge";
import { KINDS, answerText, progress, secretName } from "../core/twenty";
import { clear, h } from "./dom";
import type { ViewActions, ViewHost } from "./views";
import { t, tl } from "../i18n/i18n";

interface Turn {
  text: string;
  /** A question's answer, or a guess that was wrong. */
  label: TwentyLabel | "wrongGuess";
}

/** The dot's colour for an answer (style.css, .tq-dot.*). */
const DOT: Record<Turn["label"], string> = {
  yes: "yes",
  probablyYes: "yes soft",
  unsure: "maybe",
  probablyNo: "no soft",
  no: "no",
  wrongGuess: "wrong",
};

export function buildTwenty(actions: ViewActions): ViewHost {
  let phase: "start" | "play" | "over" = "start";
  let guessing = false;
  let busy = false;
  let error = "";
  let asked = 0;
  let total = 20;
  let turns: Turn[] = [];
  let kindLabel = "";
  /** How the game ended: won in this many questions, or the secret that was missed. */
  let ending: { won: boolean; asked: number; secret: TwentySecret | null } | null = null;
  let pool = 0;

  const input = h("input", { type: "text", class: "tq-input", maxlength: "200" }) as HTMLInputElement;
  const send = h("button", { class: "tq-btn primary", onclick: () => void submit() }) as HTMLButtonElement;
  const guess = h("button", { class: "tq-btn", onclick: () => { guessing = !guessing; draw(); input.focus(); } }) as HTMLButtonElement;
  const giveUp = h("button", { class: "tq-btn danger", text: t("Give up"), onclick: () => void quit() }) as HTMLButtonElement;
  const again = h("button", { class: "tq-btn primary big", text: t("New game"), onclick: () => { phase = "start"; error = ""; draw(); } });

  // Start: the question, and the kinds as capsules of one size.
  const kinds = h("div", { class: "tq-kinds" });
  const start = h("div", { class: "tq-start" }, h("div", { class: "tq-title", text: t("I am thinking of something. What kind?") }), kinds);

  // A game: what it is about and how far it went, the log, and the box.
  const badge = h("span", { class: "tq-badge" });
  const poolText = h("span", { class: "tq-pool" });
  const count = h("span", { class: "tq-count" });
  const dots = h("div", { class: "tq-dots" });
  const log = h("div", { class: "tq-log" });
  const reveal = h("div", { class: "tq-reveal" });
  const ask = h("div", { class: "tq-ask" }, input, send);
  const tools = h("div", { class: "tq-tools" }, guess, giveUp);
  const game = h(
    "div",
    { class: "tq-game" },
    h("div", { class: "tq-head" }, badge, poolText, h("span", { class: "tq-gap" }), count),
    dots,
    reveal,
    log,
    h("div", { class: "tq-foot" }, ask, tools),
  );
  const note = h("div", { class: "tq-note" });
  const el: HTMLElement = h("div", { class: "view twenty" }, h("div", { class: "card tq" }, start, game, note));

  for (const kind of KINDS) {
    const chip = h("button", { class: "tq-kind", text: tl(kind.label), onclick: () => void begin(kind.id, t(kind.label)) });
    chip.dataset.kind = kind.id;
    kinds.append(chip);
  }

  function drawDots() {
    clear(dots);
    for (let i = 0; i < total; i++) {
      const turn = turns[i];
      const now = phase === "play" && i === asked;
      dots.append(h("span", { class: `tq-dot ${turn ? DOT[turn.label] : ""} ${now ? "now" : ""}`.trim() }));
    }
  }

  function drawLog() {
    clear(log);
    for (const turn of [...turns].reverse()) {
      const shown = turn.label === "wrongGuess" ? { text: t("Wrong guess"), mood: "wrong" } : answerText(turn.label);
      log.append(h(
        "div",
        { class: "tq-turn" },
        h("span", { class: "tq-q", text: turn.text }),
        h("span", { class: `tq-a ${shown.mood}`.trim(), text: shown.text }),
      ));
    }
  }

  function drawReveal() {
    clear(reveal);
    if (phase !== "over" || !ending) return;
    const secret = ending.secret;
    const name = secret ? secretName(secret) : "?";
    reveal.append(
      h("div", { class: `tq-card ${ending.won ? "won" : "lost"}` },
        h("div", { class: "tq-card-text" },
          h("div", { class: "tq-card-label", text: ending.won ? t("You got it in {n} questions!", { n: ending.asked }) : t("Better luck next time.") }),
          h("div", { class: "tq-card-name", text: name }),
          secret && name !== secret.en ? h("div", { class: "tq-card-sub", text: secret.en }) : null,
        ),
        again,
      ),
    );
  }

  function draw() {
    start.style.display = phase === "start" ? "" : "none";
    game.style.display = phase === "start" ? "none" : "";
    ask.style.display = phase === "play" ? "" : "none";
    tools.style.display = phase === "play" ? "" : "none";
    note.textContent = error;
    note.classList.toggle("err", error !== "");
    note.style.display = error ? "" : "none";
    send.disabled = busy;
    send.textContent = busy ? t("Asking JEV…") : guessing ? t("Guess") : t("Ask");
    guess.textContent = guessing ? t("Back to questions") : t("I know it!");
    guess.classList.toggle("on", guessing);
    input.placeholder = guessing ? t("What is it?") : t("Ask a yes/no question…");
    input.classList.toggle("guessing", guessing);
    badge.textContent = kindLabel;
    poolText.textContent = pool > 0 ? t("I am thinking of one of {n} things.", { n: pool.toLocaleString() }) : "";
    count.textContent = phase === "play" ? progress(asked, total) : "";
    if (phase !== "start") {
      drawDots();
      drawLog();
      drawReveal();
    }
  }

  async function begin(kind: string, label: string) {
    actions.blip();
    error = "";
    try {
      const started = await Bridge.twentyNew(kind);
      total = started?.total ?? 20;
      pool = started?.pool ?? 0;
      kindLabel = label;
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
