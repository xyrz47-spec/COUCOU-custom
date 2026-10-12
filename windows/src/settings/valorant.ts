// Settings → Valorant: the match reviews kept on this PC
// (src-tauri/src/valorant.rs). Each review lists the habits most worth
// changing, then the moments they come from: when in the video, what was seen,
// what is inferred and how sure that is, what else could have been done, and
// one drill. The user can add a note to a review and delete one or all of them.

import { providerDef, PROVIDERS } from "../core/providers";
import { Bridge, onEvent, type ValorantRecorderStatus, type ValorantEvents, type ValorantPlan, type ValorantReview } from "../core/bridge";
import type { Settings } from "../core/state";
import { clear, h } from "../views/dom";
import { t } from "../i18n/i18n";

export { clockText } from "../views/valorant";
import { clockText, statusText } from "../views/valorant";

function field(label: string, text: string): HTMLElement | null {
  return text.trim() ? h("div", { class: "hint", text: `${label}: ${text}` }) : null;
}

/** The events a user pasted, or why they are not usable. */
export function parseEvents(text: string): ValorantEvents | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return t("The events are not valid JSON.");
  }
  const v = value as Partial<ValorantEvents> | null;
  if (!v || typeof v.videoMs !== "number" || !Array.isArray(v.events)) {
    return t("Expected videoMs and a list of events, each with atMs, kind and detail.");
  }
  return v as ValorantEvents;
}

export function valorantSection(current: () => Settings, save: () => Promise<void>): HTMLElement {
  const list = h("div", { style: "display:flex;flex-direction:column;gap:14px" });
  const note = h("div", { class: "notice err", style: "display:none" });
  const wipe = h("button", { class: "danger", text: t("Delete all reviews") }) as HTMLButtonElement;
  let armed = false;

  const say = (text: string) => {
    note.textContent = text;
    note.style.display = text ? "" : "none";
  };

  function card(review: ValorantReview): HTMLElement {
    const noteBox = h("textarea", {
      placeholder: t("Your note on this review"), style: "width:100%;min-height:48px",
    }) as HTMLTextAreaElement;
    noteBox.value = review.userNote;
    noteBox.addEventListener("change", () => {
      Bridge.valorantReviewNote(review.id, noteBox.value).then(() => say("")).catch((err) => say(String(err)));
    });
    const moments = review.findings.map((f) =>
      h(
        "div",
        { style: "border-left:2px solid var(--dim-2);padding-left:10px;display:flex;flex-direction:column;gap:2px" },
        h("div", { text: `${clockText(f.startMs)}–${clockText(f.endMs)} · ${f.category}` }),
        field(t("Seen"), f.fact),
        field(t("Inferred"), f.inference),
        field(t("Why"), f.reasoning),
        field(t("Instead"), f.alternative),
        field(t("How sure"), f.uncertainty),
        field(t("Practise"), f.drill),
      ),
    );
    return h(
      "div",
      { class: "row", style: "flex-direction:column;align-items:stretch;gap:8px" },
      h("div", { text: new Date(review.createdAt * 1000).toLocaleString() }),
      ...review.didWell.map((text) => h("div", { class: "hint", text: `+ ${text}` })),
      ...review.topIssues.map((text) => h("div", { text: `• ${text}` })),
      field(t("Next match"), review.nextGoal),
      ...moments,
      noteBox,
      h("button", {
        class: "danger",
        text: t("Delete this review"),
        onclick: () => {
          Bridge.valorantReviewDelete(review.id).then(() => load()).catch((err) => say(String(err)));
        },
      }),
    );
  }

  async function load() {
    const found = await Bridge.valorantReviews();
    clear(list);
    const reviews = found?.reviews ?? [];
    if (reviews.length === 0) {
      list.append(h("div", { class: "hint", text: t("No reviews yet.") }));
    }
    for (const review of reviews) list.append(card(review));
    if (found && found.skipped > 0) {
      list.append(h("div", { class: "hint", text: t("{n} files in the reviews folder are not valid reviews and were left alone.", { n: found.skipped }) }));
    }
    wipe.disabled = reviews.length === 0;
  }

  wipe.addEventListener("click", () => {
    // A first click asks; only a second one deletes.
    if (!armed) {
      armed = true;
      wipe.textContent = t("Click again to delete all");
      window.setTimeout(() => {
        armed = false;
        wipe.textContent = t("Delete all reviews");
      }, 3000);
      return;
    }
    armed = false;
    wipe.textContent = t("Delete all reviews");
    Bridge.valorantReviewsDeleteAll().then(() => load()).catch((err) => say(String(err)));
  });

  // ── Recording the game window (src-tauri/src/recorder.rs) ───────────────────
  const recState = h("div", { class: "hint" });
  const recSwitch = h("button", { class: current().valorantRecord ? "switch on" : "switch", "aria-pressed": current().valorantRecord });
  recSwitch.addEventListener("click", () => {
    const next = !recSwitch.classList.contains("on");
    recSwitch.classList.toggle("on", next);
    current().valorantRecord = next;
    void save();
  });
  const recText = statusText;
  void Bridge.valorantRecorderStatus().then((s) => { recState.textContent = recText(s ?? null); });
  void onEvent<ValorantRecorderStatus>("valorant-recorder", (s) => { recState.textContent = recText(s); });

  // ── Who judges (valorant_judge.rs) ──────────────────────────────────────────
  const judge = h("select", { class: "sk-where" }) as HTMLSelectElement;
  judge.append(h("option", { value: "", text: t("Same as the chat") }));
  for (const def of PROVIDERS) judge.append(h("option", { value: def.id, text: def.name }));
  judge.value = current().valorantJudge ?? "";
  judge.addEventListener("change", () => {
    current().valorantJudge = judge.value;
    void save();
  });

  // ── The player's own reference notes ────────────────────────────────────────
  const notesBox = h("textarea", {
    placeholder: t("Notes from pro or Radiant players you want the review to use"), style: "width:100%;min-height:72px",
  }) as HTMLTextAreaElement;
  void Bridge.valorantNotes().then((text) => { notesBox.value = text ?? ""; });
  notesBox.addEventListener("change", () => {
    Bridge.valorantNotesSet(notesBox.value).then(() => say("")).catch((err) => say(String(err)));
  });

  // ── Analysing a match: show what would be sent, send only after a click ─────
  const eventsBox = h("textarea", {
    placeholder: '{"videoMs": 1500000, "events": [{"atMs": 61000, "kind": "death", "detail": "…"}]}',
    style: "width:100%;min-height:72px;font-family:var(--mono)",
  }) as HTMLTextAreaElement;
  const plan = h("div", { class: "hint" });
  const check = h("button", { text: t("Show what would be sent") }) as HTMLButtonElement;
  const send = h("button", { class: "primary", text: t("Send and analyse"), style: "display:none" }) as HTMLButtonElement;
  let parsed: ValorantEvents | null = null;
  eventsBox.addEventListener("input", () => {
    send.style.display = "none";
    plan.textContent = "";
  });
  check.addEventListener("click", () => {
    const events = parseEvents(eventsBox.value);
    send.style.display = "none";
    if (typeof events === "string") return say(events);
    Bridge.valorantAnalysisPlan(events)
      .then((p: ValorantPlan) => {
        say("");
        parsed = events;
        const line = (label: string, step: ValorantPlan["options"]) =>
          `${label}: ${providerDef(step.provider).name} · ${step.model || "?"} — ${t("about {tokens} tokens", { tokens: step.estimatedTokens })} — ${step.external ? t("The events leave this PC.") : t("The events stay on this PC.")}`;
        plan.textContent = [line(t("1 · Options"), p.options), line(t("2 · Judgement"), p.judge)].join("\n");
        plan.style.whiteSpace = "pre-line";
        send.disabled = p.options.estimatedTokens > p.tokenLimit;
        send.style.display = "";
      })
      .catch((err) => say(String(err)));
  });
  send.addEventListener("click", () => {
    if (!parsed) return;
    send.disabled = true;
    send.textContent = t("Analysing…");
    Bridge.valorantAnalyse(parsed, true)
      .then(() => {
        say("");
        eventsBox.value = "";
        plan.textContent = "";
        send.style.display = "none";
        return load();
      })
      .catch((err) => say(String(err)))
      .finally(() => {
        send.disabled = false;
        send.textContent = t("Send and analyse");
      });
  });

  void load();
  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: t("Valorant reviews") })),
    h("div", {
      class: "hint",
      text: t("Reviews of your matches are kept on this PC. Recording a match is not in this build yet."),
    }),
    h("h2", {}, h("span", { text: t("Recording") })),
    h("div", { class: "row" },
      h("span", { text: t("Record the VALORANT window while the game runs") }), recSwitch),
    h("div", {
      class: "hint",
      text: t("Only the game's window is captured, with no sound, by ffmpeg (it has to be installed). It starts when the window appears and stops when it closes, at 90 minutes, or when the drive is nearly full. The lobby is in the same window, so a recording holds more than one match."),
    }),
    recState,
    h("h2", {}, h("span", { text: t("Who judges") })),
    h("div", {
      class: "hint",
      text: t("A language model (the chat provider of Settings → Chat, Claude for instance) lists the options for each decision. The judge compares what the player did with those options, given the events before and after. A JEV server goes in as the Custom server."),
    }),
    h("div", { class: "row" }, h("span", { text: t("Judge") }), judge),
    h("h2", {}, h("span", { text: t("Reference notes") })),
    h("div", {
      class: "hint",
      text: t("The review judges your play against a guide of commonly taught habits (general convention, not data from any player's games). Notes you paste here are added to it."),
    }),
    notesBox,
    h("h2", {}, h("span", { text: t("Analyse a match") })),
    h("div", {
      class: "hint",
      text: t("Paste the events of a match. The options come from the chat provider and the judgement from the judge above; nothing is sent until you confirm."),
    }),
    eventsBox,
    h("div", { class: "row" }, check, send),
    plan,
    list,
    note,
    h("div", { class: "row" }, wipe),
  );
}
