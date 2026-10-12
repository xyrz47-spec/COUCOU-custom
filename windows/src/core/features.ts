// What this build adds to Coucou, one switch each — Settings → Features.
// A feature turned off leaves the island and the settings window; what was set
// for it (a city, the launcher's tiles, a clock's form) is kept for when it
// comes back. Only the ids turned off are saved (settings.disabledFeatures), so
// a feature added later starts on.
// Pure data and helpers, so they can be tested without a webview.

import { N_ } from "../i18n/i18n";

export type FeatureId =
  | "claudeChat" | "skillsTab" | "pluginSkills" | "skillAdvice" | "launcherTab" | "valorantReview"
  | "musicPlayer" | "compactSong" | "clock" | "weather" | "motion";

export type FeatureGroup = "claude" | "tabs" | "compact" | "look";

export interface FeatureDef {
  id: FeatureId;
  group: FeatureGroup;
  name: string;
  about: string;
  /** The feature it is part of: off with it, whatever its own switch says. */
  needs?: FeatureId;
  /** Where its own settings are: a page of the settings window, and a spot on it. */
  page?: string;
  anchor?: string;
}

export const FEATURE_GROUPS: readonly { id: FeatureGroup; title: string }[] = [
  { id: "claude", title: "Claude Code" },
  { id: "tabs", title: N_("Island tabs") },
  { id: "compact", title: N_("Compact island") },
  { id: "look", title: N_("Look") },
];

export const FEATURES: readonly FeatureDef[] = [
  {
    id: "claudeChat", group: "claude", name: N_("Chat with Claude Code"), page: "chat", anchor: "claudeChat",
    about: N_("The chat answered through Claude Code, on the plan you already have: no API key, and an effort to pick. Off, the chat goes back to the providers that take a key."),
  },
  {
    id: "skillsTab", group: "tabs", name: N_("Skills tab"),
    about: N_("The island's star tab: Claude Code's skills, turned on and off, searched for and added, in a folder of your choice."),
  },
  {
    id: "pluginSkills", group: "tabs", name: N_("Skills of installed plugins"), needs: "skillsTab",
    about: N_("In the skills tab, the skills that come with the plugins installed in Claude Code (/plugin install…), read-only: Claude Code turns a plugin on or off."),
  },
  {
    id: "skillAdvice", group: "tabs", name: N_("Skills picked by Claude Code"), needs: "skillsTab",
    about: N_("In the skills tab, Claude Code says what to add and what to remove for a project. Each ask counts against your plan."),
  },
  {
    id: "launcherTab", group: "tabs", name: N_("Launcher tab"), page: "launcher",
    about: N_("The island's grid tab: your websites and apps, one click each, with the apps installed on this PC to search and add."),
  },
  {
    id: "valorantReview", group: "tabs", name: N_("Valorant match reviews"), page: "valorant",
    about: N_("A settings page for the reviews of your Valorant matches, kept on this PC: read them, add a note, delete one or all."),
  },
  {
    id: "musicPlayer", group: "tabs", name: N_("Big music player"),
    about: N_("The button on Spotify's card that lets the player take the whole island."),
  },
  {
    id: "compactSong", group: "compact", name: N_("Song in the compact island"),
    about: N_("While a song plays: its cover, its title and how far it is, in the compact island."),
  },
  {
    id: "clock", group: "compact", name: N_("Clock"), page: "general", anchor: "clock",
    about: N_("The time in the compact island, while no song shows there."),
  },
  {
    id: "weather", group: "compact", name: N_("Weather"), needs: "clock", page: "general", anchor: "weather",
    about: N_("The weather's icon and the temperature beside the clock, for the city you picked. Off, nothing is asked of the weather service."),
  },
  {
    id: "motion", group: "look", name: N_("Animations"),
    about: N_("How the settings window and the island's tabs move. Off, things change at once."),
  },
];

/** More than any list of features would hold: what a settings file may carry. */
export const MAX_DISABLED = 32;

export function isFeature(id: unknown): id is FeatureId {
  return typeof id === "string" && FEATURES.some((f) => f.id === id);
}

export function featureDef(id: FeatureId): FeatureDef {
  return FEATURES.find((f) => f.id === id)!;
}

/** What `settings.disabledFeatures` says, whatever shape it came in. */
function disabled(settings: { disabledFeatures?: unknown }): readonly unknown[] {
  return Array.isArray(settings.disabledFeatures) ? settings.disabledFeatures : [];
}

/** The switch itself, as Settings → Features shows it. */
export function featureSwitch(settings: { disabledFeatures?: unknown }, id: FeatureId): boolean {
  return !disabled(settings).includes(id);
}

/** The feature is in force: its switch is on, and so is the feature it is part of. */
export function featureOn(settings: { disabledFeatures?: unknown }, id: FeatureId): boolean {
  if (!featureSwitch(settings, id)) return false;
  const needs = featureDef(id).needs;
  return needs ? featureOn(settings, needs) : true;
}

/** `disabledFeatures` with `id` turned on or off: known ids only, each once, in the catalog's order. */
export function withFeature(settings: { disabledFeatures?: unknown }, id: FeatureId, on: boolean): FeatureId[] {
  const off = new Set(disabled(settings).filter(isFeature));
  if (on) off.delete(id);
  else off.add(id);
  return FEATURES.map((f) => f.id).filter((f) => off.has(f));
}

/** How many switches are on, of how many. */
export function featureCount(settings: { disabledFeatures?: unknown }): { on: number; of: number } {
  return { on: FEATURES.filter((f) => featureSwitch(settings, f.id)).length, of: FEATURES.length };
}
