// Twenty questions (views/twenty.ts, src-tauri/src/twenty.rs): the kinds to
// choose from and the words for JEV's answers. Pure, so they can be tested
// without a webview.

import type { TwentyLabel } from "./bridge";
import { N_, t } from "../i18n/i18n";

/** What Coucou can think of: the id twenty.rs knows, and the button's words. */
export const KINDS: readonly { id: string; label: string }[] = [
  { id: "animal", label: N_("An animal") },
  { id: "food", label: N_("A food") },
  { id: "thing", label: N_("An object") },
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

/** The names Coucou may think of (twenty.rs, ITEMS), as keys to translate when the secret is told. */
export const ITEM_NAMES = [
  N_("Elephant"), N_("Dog"), N_("Penguin"), N_("Dolphin"), N_("Butterfly"), N_("Giraffe"),
  N_("Pizza"), N_("Banana"), N_("Ice cream"), N_("Bread"), N_("Egg"), N_("Rice"),
  N_("Umbrella"), N_("Bicycle"), N_("Telephone"), N_("Clock"), N_("Book"), N_("Toothbrush"),
] as const;

/** The secret in the interface language. */
export function itemName(name: string): string {
  return t(name);
}

/** "Question 3 of 20". */
export function progress(asked: number, total: number): string {
  return t("Question {n} of {total}", { n: Math.min(asked + 1, total), total });
}
