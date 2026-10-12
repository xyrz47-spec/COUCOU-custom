// Valorant view — the island's sixth tab: the reviews of your matches and the
// recorder's state, to read at a glance (src-tauri/src/valorant.rs, recorder.rs).
//
// A review shows the habits most worth changing; a click opens its moments
// (when in the video, what was seen, what is inferred, how sure that is, what
// else could have been done, a drill, and the guide section it is judged
// against). Recording is switched on and notes are pasted in Settings →
// Valorant; analysing a match is also there. Reviews and recordings stay on
// this PC.
//
// It reuses the skills tab's look (style.css, .sk-*): no new style.

import { Bridge, onEvent, type ValorantRecorderStatus, type ValorantRecording, type ValorantReview } from "../core/bridge";
import { State } from "../core/state";
import { clear, h } from "./dom";
import type { ViewActions, ViewHost } from "./views";
import { t } from "../i18n/i18n";

/** `m:ss` for a moment in the video. */
export function clockText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Bytes as MB or GB, for a recording's size. */
export function sizeText(bytes: number): string {
  return bytes >= 1 << 30 ? `${(bytes / (1 << 30)).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / (1 << 20)))} MB`;
}

export function statusText(s: ValorantRecorderStatus | null): string {
  switch (s?.state) {
    case "recording": return t("Recording the VALORANT window");
    case "waiting": return t("Waiting for VALORANT");
    case "noFfmpeg": return t("ffmpeg was not found: install it to record");
    case "lowDisk": return t("The drive is nearly full: not recording");
    case "failed": return s.detail || t("Recording failed");
    default: return t("Recording is off");
  }
}

export function buildValorant(actions: ViewActions): ViewHost {
  let reviews: ValorantReview[] = [];
  let skipped = 0;
  let recordings: ValorantRecording[] = [];
  let status: ValorantRecorderStatus | null = null;
  let open = "";
  let tab: "reviews" | "recordings" = "reviews";

  const tabReviews = h("button", { text: t("Reviews"), onclick: () => show("reviews") });
  const tabRecordings = h("button", { text: t("Recordings"), onclick: () => show("recordings") });
  const state = h("span", { class: "sk-count" });
  const settingsBtn = h("button", { class: "sk-btn", text: t("Settings"), onclick: () => { actions.blip(); void Bridge.openSettingsWindow(); } });
  const list = h("div", { class: "sk-list" });
  const el: HTMLElement = h(
    "div",
    { class: "view skills valorant" },
    h(
      "div",
      { class: "card" },
      h("div", { class: "sk-top" }, h("div", { class: "seg sk-seg" }, tabReviews, tabRecordings), state, settingsBtn),
      list,
    ),
  );

  function show(next: "reviews" | "recordings") {
    actions.blip();
    tab = next;
    draw();
  }

  function reviewRow(review: ValorantReview): HTMLElement {
    const opened = open === review.id;
    const head = h(
      "div",
      { class: "sk-row", style: "cursor:pointer", onclick: () => { open = opened ? "" : review.id; draw(); } },
      h(
        "div",
        { class: "sk-text" },
        h("div", { class: "sk-name" },
          h("span", { text: review.topIssues[0] ?? "" }),
          h("span", { class: "sk-tag", text: new Date(review.createdAt * 1000).toLocaleDateString() }),
        ),
        h("div", { class: "sk-desc", text: review.topIssues.slice(1).join(" · ") || review.nextGoal }),
      ),
    );
    if (!opened) return head;
    const rows: HTMLElement[] = [head];
    if (review.nextGoal) rows.push(h("div", { class: "sk-desc", text: `${t("Next match")}: ${review.nextGoal}` }));
    for (const f of review.findings) {
      rows.push(h(
        "div",
        { class: "sk-row" },
        h(
          "div",
          { class: "sk-text" },
          h("div", { class: "sk-name" },
            h("span", { text: `${clockText(f.startMs)}–${clockText(f.endMs)}` }),
            h("span", { class: "sk-tag", text: f.category }),
            h("span", { class: "sk-tag", text: f.guide }),
          ),
          ...[
            [t("Seen"), f.fact], [t("Inferred"), f.inference], [t("Why"), f.reasoning],
            [t("Instead"), f.alternative], [t("How sure"), f.uncertainty], [t("Practise"), f.drill],
          ].filter(([, text]) => text.trim()).map(([label, text]) => h("div", { class: "sk-desc", text: `${label}: ${text}`, title: text })),
        ),
      ));
    }
    return h("div", {}, ...rows);
  }

  function recordingRow(rec: ValorantRecording): HTMLElement {
    const remove = h("button", { class: "sk-btn danger", text: t("Remove") }) as HTMLButtonElement;
    let armed = false;
    remove.addEventListener("click", () => {
      // A first click asks; only a second one, soon after, deletes.
      if (!armed) {
        armed = true;
        remove.textContent = t("Click again to remove");
        window.setTimeout(() => { armed = false; remove.textContent = t("Remove"); }, 3000);
        return;
      }
      void Bridge.valorantRecordingsDelete(rec.name).then(load).catch(() => {});
    });
    return h(
      "div",
      { class: "sk-row" },
      h("div", { class: "sk-text" },
        h("div", { class: "sk-name" }, h("span", { text: new Date(rec.modified * 1000).toLocaleString() }), h("span", { class: "sk-tag", text: sizeText(rec.bytes) })),
        h("div", { class: "sk-desc", text: rec.name })),
      h("div", { class: "sk-actions" }, remove),
    );
  }

  function draw() {
    tabReviews.classList.toggle("on", tab === "reviews");
    tabRecordings.classList.toggle("on", tab === "recordings");
    state.textContent = statusText(status);
    clear(list);
    if (tab === "reviews") {
      for (const review of reviews) list.append(reviewRow(review));
      if (reviews.length === 0) list.append(h("div", { class: "sk-empty", text: t("No reviews yet.") }));
      if (skipped > 0) list.append(h("div", { class: "sk-desc", text: t("{n} files in the reviews folder are not valid reviews and were left alone.", { n: skipped }) }));
      return;
    }
    for (const rec of recordings) list.append(recordingRow(rec));
    if (recordings.length === 0) list.append(h("div", { class: "sk-empty", text: t("No recordings.") }));
    else {
      list.append(h("button", { class: "sk-btn", text: t("Open the folder"), onclick: () => void Bridge.valorantRecordingsReveal() }));
    }
  }

  async function load() {
    const [found, recs, now] = await Promise.all([Bridge.valorantReviews(), Bridge.valorantRecordings(), Bridge.valorantRecorderStatus()]);
    reviews = found?.reviews ?? [];
    skipped = found?.skipped ?? 0;
    recordings = recs ?? [];
    status = now ?? status;
    draw();
  }

  void onEvent<ValorantRecorderStatus>("valorant-recorder", (next) => {
    status = next;
    // A recording just ended: it shows in the list.
    if (next.state !== "recording") void load();
    else draw();
  });

  let shown = false;
  return {
    el,
    sync() {
      // Read again whenever the tab comes into view.
      const here = State.view === "valorant";
      if (here && !shown) void load();
      shown = here;
    },
  };
}
