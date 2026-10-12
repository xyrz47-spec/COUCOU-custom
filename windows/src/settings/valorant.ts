// Settings → Valorant: the match reviews kept on this PC
// (src-tauri/src/valorant.rs). Each review lists the habits most worth
// changing, then the moments they come from: when in the video, what was seen,
// what is inferred and how sure that is, what else could have been done, and
// one drill. The user can add a note to a review and delete one or all of them.

import { Bridge, type ValorantReview } from "../core/bridge";
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

  void load();
  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: t("Valorant reviews") })),
    h("div", {
      class: "hint",
      text: t("Reviews of your matches stay on this PC. Nothing is sent anywhere from here. Recording a match and having it analysed are not in this build yet."),
    }),
    list,
    note,
    h("div", { class: "row" }, wipe),
  );
}
