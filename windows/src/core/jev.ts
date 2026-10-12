// JEV's read of a message (src-tauri/src/jev.rs) put into words for the Check
// tab: how it sounds, how urgent it is, whether it needs a reply, whether it
// could sound rude. Pure, so it can be tested without a webview.

import type { JevMessageRead } from "./bridge";
import { N_, t } from "../i18n/i18n";

const TONES: Record<string, string> = {
  friendly: N_("friendly"),
  neutral: N_("neutral"),
  formal: N_("formal"),
  stern: N_("stern"),
  upset: N_("upset"),
};

/** A tone is only named when JEV is reasonably sure of it. */
const TONE_SURE = 0.4;
/** From this likelihood on, a yes/no question counts as yes. */
const YES = 0.5;

export type Mood = "good" | "watch" | "warn";

export interface ReadLine {
  label: string;
  value: string;
  mood: Mood;
}

export function percent(x: number): string {
  return `${Math.round(Math.min(1, Math.max(0, x)) * 100)}%`;
}

/** The four lines of a read, in the order the tab shows them. */
export function describe(read: JevMessageRead): ReadLine[] {
  const tone = TONES[read.tone];
  const sure = tone != null && read.toneConfidence >= TONE_SURE;
  const urgency = read.urgency < 0.5
    ? { value: t("not urgent"), mood: "good" as const }
    : read.urgency < 1.5
      ? { value: t("soon"), mood: "watch" as const }
      : { value: t("urgent"), mood: "warn" as const };
  return [
    {
      label: t("Sounds"),
      value: sure ? t(tone) : t("hard to tell"),
      mood: sure && (read.tone === "stern" || read.tone === "upset") ? "watch" : "good",
    },
    { label: t("Urgency"), ...urgency },
    {
      label: t("Reply"),
      value: read.needsReply >= YES ? t("asks for an answer ({n})", { n: percent(read.needsReply) }) : t("none needed ({n})", { n: percent(read.needsReply) }),
      mood: read.needsReply >= YES ? "watch" : "good",
    },
    {
      label: t("Could sound rude"),
      value: read.rude >= YES ? t("yes ({n})", { n: percent(read.rude) }) : t("no ({n})", { n: percent(read.rude) }),
      mood: read.rude >= YES ? "warn" : "good",
    },
  ];
}
