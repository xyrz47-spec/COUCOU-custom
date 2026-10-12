// Everyday help to pick, by JEV (src-tauri/src/jev.rs): the options a person
// types, the presets that fill them in, and the ranking that comes back in
// words. Pure, so it can be tested without a webview.

import type { JevDecision } from "./bridge";
import { N_, t } from "../i18n/i18n";

/** As many options as jev.rs sends (MAX_OPTIONS). */
export const MAX_OPTIONS = 10;

/** Presets for the options box: a label, and what it fills in. Strings are English keys, shown with `t()`. */
export const PRESETS: readonly { label: string; options: readonly string[] }[] = [
  { label: N_("Meal"), options: [N_("Rice dish"), N_("Noodles"), N_("Soup"), N_("Salad"), N_("Sandwich"), N_("Pizza"), N_("Sushi"), N_("Fried chicken")] },
  { label: N_("Drink"), options: [N_("Coffee"), N_("Tea"), N_("Water"), N_("Juice"), N_("Milk")] },
  { label: N_("Activity"), options: [N_("Go for a walk"), N_("Take a nap"), N_("Read"), N_("Watch a movie"), N_("Work out"), N_("Call a friend")] },
];

/** The text a preset puts in the box, one option per line, in the interface language. */
export function presetText(index: number): string {
  return (PRESETS[index]?.options ?? []).map((o) => t(o)).join("\n");
}

/** The options in a box: one per line or separated by commas, each once, trimmed, at most MAX_OPTIONS. */
export function parseOptions(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/[\n,，、;]+/)) {
    const option = part.trim();
    if (option && !out.some((o) => o.toLowerCase() === option.toLowerCase())) out.push(option);
  }
  return out.slice(0, MAX_OPTIONS);
}

export function percent(x: number): string {
  return `${Math.round(Math.min(1, Math.max(0, x)) * 100)}%`;
}

export interface Row {
  option: string;
  share: string;
  /** 0 to 100: the bar's width, relative to the best one. */
  width: number;
  best: boolean;
}

/** The ranking as rows: the best first, each bar measured against it. */
export function rows(decision: JevDecision): Row[] {
  const top = Math.max(...decision.ranking.map((r) => r.share), 0.0001);
  return decision.ranking.map((r, i) => ({
    option: r.option,
    share: percent(r.share),
    width: Math.round((r.share / top) * 100),
    best: i === 0,
  }));
}

/** A line under the ranking when JEV is not sure of the first. */
export function doubt(decision: JevDecision): string | null {
  return decision.confidence < 0.5 ? t("JEV is not very sure: the first ones are close.") : null;
}
