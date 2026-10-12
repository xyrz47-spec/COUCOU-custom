// Twenty questions (views/twenty.ts, src-tauri/src/twenty.rs): the kinds to
// choose from and the words for JEV's answers. Pure, so they can be tested
// without a webview.

import type { TwentyLabel, TwentySecret } from "./bridge";
import { N_, language, t } from "../i18n/i18n";

/** What Coucou can think of: the id twenty.rs knows, and the button's words. */
export const KINDS: readonly { id: string; label: string }[] = [
  { id: "animal", label: N_("An animal") },
  { id: "food", label: N_("A food") },
  { id: "thing", label: N_("An object") },
  { id: "place", label: N_("A place") },
  { id: "job", label: N_("A job") },
  { id: "nature", label: N_("Something in nature") },
  { id: "pokemon", label: N_("A Pokémon") },
  { id: "character", label: N_("A character") },
  { id: "body", label: N_("A body part") },
  { id: "activity", label: N_("An activity") },
  { id: "any", label: N_("Anything") },
];

const ANSWERS: Record<TwentyLabel, { text: string; mood: "ok" | "bad" | "" }> = {
  yes: { text: N_("Yes"), mood: "ok" },
  probablyYes: { text: N_("Probably yes"), mood: "ok" },
  unsure: { text: N_("Not sure"), mood: "" },
  probablyNo: { text: N_("Probably not"), mood: "bad" },
  no: { text: N_("No"), mood: "bad" },
};

export function answerText(label: TwentyLabel): { text: string; mood: "ok" | "bad" | "" } {
  const found = ANSWERS[label] ?? ANSWERS.unsure;
  return { text: t(found.text), mood: found.mood };
}

/** The secret as the game ends: in Korean (with the English beside it) on a Korean interface, else in English. */
export function secretText(secret: TwentySecret, lang: string = language()): string {
  return lang === "ko" ? `${secret.ko} (${secret.en})` : secret.en;
}

/** "Question 3 of 20". */
export function progress(asked: number, total: number): string {
  return t("Question {n} of {total}", { n: Math.min(asked + 1, total), total });
}
