// Settings → Valorant: the match reviews kept on this PC
// (src-tauri/src/valorant.rs). Each review lists the habits most worth
// changing, then the moments they come from: when in the video, what was seen,
// what is inferred and how sure that is, what else could have been done, and
// one drill. The user can add a note to a review and delete one or all of them.

import { Bridge, type ValorantEvents, type ValorantPlan, type ValorantReview } from "../core/bridge";
import { clear, h } from "../views/dom";
import { t } from "../i18n/i18n";

/** `m:ss` for a moment in the video. */
export function clockText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

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

export function valorantSection(): HTMLElement {
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
        plan.textContent = t("{provider} · {model} — about {tokens} tokens ({limit} at most). {where}", {
          provider: p.provider,
          model: p.model || "?",
          tokens: p.estimatedTokens,
          limit: p.tokenLimit,
          where: p.external ? t("The events leave this PC.") : t("The events stay on this PC."),
        });
        send.disabled = p.estimatedTokens > p.tokenLimit;
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
    h("h2", {}, h("span", { text: t("Analyse a match") })),
    h("div", {
      class: "hint",
      text: t("Paste the events of a match. The analysis uses the chat provider picked in Settings → Chat (a JEV server goes there as a custom server); nothing is sent until you confirm."),
    }),
    eventsBox,
    h("div", { class: "row" }, check, send),
    plan,
    list,
    note,
    h("div", { class: "row" }, wipe),
  );
}
