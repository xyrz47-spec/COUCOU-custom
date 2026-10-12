// The features of this build, as a manager — Settings → Features.
//
// A feature is a module that can be turned on and off, like a mod: its
// declaration is an entry of features.json (what it is part of, what it plugs
// into: an island tab, a settings page, pills), its text is in TEXT below, and
// the code that is the feature checks `featureOn(settings, id)` where it plugs
// in. The island's header tabs, the settings window's pages and the Rust side
// (src-tauri/src/features.rs, from the same features.json) all follow the
// declarations, so adding or removing a feature is a change in these two
// places and in the code of the feature itself.
//
// A feature turned off leaves the island and the settings window; what was set
// for it (a city, the launcher's tiles, a clock's form) is kept for when it
// comes back. Only the ids turned off are saved (settings.disabledFeatures), so
// a feature added later starts on.
// Pure data and helpers, so they can be tested without a webview.

import MANIFEST from "./features.json";
import { N_ } from "../i18n/i18n";

/** An id of features.json (checked against it by tests/features.test.mjs). */
export type FeatureId = string;
export type FeatureGroup = string;

/** An island tab a feature adds to the header. */
export interface FeatureTab {
  /** The island view it opens. */
  view: string;
  /** A key of ICONS (views/icons.ts). */
  icon: string;
  /** Where it stands among the feature tabs, left to right. */
  order: number;
}

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
  /** The tab it adds to the island's header, with the words on it. */
  tab?: FeatureTab & { title: string };
  /** A page of the settings window that is the feature's own: there when it is on. */
  settingsPage?: { id: string; label: string; color: string };
  /** Pills (src/core/pills.ts) that are the feature's: not offered, not shown, while it is off. */
  pills: string[];
}

interface Entry {
  id: string;
  group: string;
  needs?: string;
  page?: string;
  anchor?: string;
  tab?: FeatureTab;
  settingsPage?: { id: string; color: string };
  pills?: string[];
}

/** The words of each feature, by id. Strings are English keys, shown with `t()`. */
const TEXT: Record<string, { name: string; about: string; tab?: string; page?: string }> = {
  claudeChat: {
    name: N_("Chat with Claude Code"),
    about: N_("The chat answered through Claude Code, on the plan you already have: no API key, and an effort to pick. Off, the chat goes back to the providers that take a key."),
  },
  skillsTab: {
    name: N_("Skills tab"), tab: N_("Skills"),
    about: N_("The island's star tab: Claude Code's skills, turned on and off, searched for and added, in a folder of your choice."),
  },
  pluginSkills: {
    name: N_("Skills of installed plugins"),
    about: N_("In the skills tab, the skills that come with the plugins installed in Claude Code (/plugin install…), read-only: Claude Code turns a plugin on or off."),
  },
  skillFind: {
    name: N_("Find skills"),
    about: N_("In the skills tab, the search of skills.sh with its fields to pick from, and adding a result with one click. Off, no search is made."),
  },
  skillAdvice: {
    name: N_("Skills picked by Claude Code"),
    about: N_("In the skills tab, Claude Code says what to add and what to remove for a project. Each ask counts against your plan."),
  },
  planUsage: {
    name: N_("Plan usage in the header"),
    about: N_("Claude's and Codex's 5-hour and weekly limits, as pills in the island's header once you turn them on in Settings → Claude Code."),
  },
  launcherTab: {
    name: N_("Launcher tab"), tab: N_("Launcher"), page: N_("Launcher"),
    about: N_("The island's grid tab: your websites and apps, one click each, with the apps installed on this PC to search and add."),
  },
  launcherApps: {
    name: N_("Installed apps"),
    about: N_("In the launcher's add window, the list of the apps installed on this PC, to search and add. Off, the Start menu is not read."),
  },
  launcherFavicons: {
    name: N_("Website icons"),
    about: N_("A site's own icon on its launcher tile, fetched from that site once. Off, the site is not asked and the tile keeps its mini Mochi."),
  },
  decide: {
    name: N_("Decide tab"), tab: N_("Decide"), page: N_("JEV"),
    about: N_("The island's decide tab: say how you feel, list a few options — what to eat, drink or do — and JEV ranks them. Needs your TypeSafe API key."),
  },
  decidePresets: {
    name: N_("Presets for the options"),
    about: N_("Meal, drink and activity lists that fill the options box in one click."),
  },
  decideRemember: {
    name: N_("Remember the last options"),
    about: N_("The options box comes back with what you last chose between. Kept in this window only; the feeling is never kept."),
  },
  spotify: {
    name: N_("Spotify"),
    about: N_("The Spotify pill: what is playing, with play/pause and skip. Off, Coucou does not look at Spotify at all, and the music features below wait for it."),
  },
  spotifyDance: {
    name: N_("Mochi dances to the music"),
    about: N_("While a song plays, Mochi dances: in the island, on the Spotify card and on the desktop."),
  },
  songAnnounce: {
    name: N_("Announce songs"),
    about: N_("The island names a new song when it starts, if Settings → General asks for it."),
  },
  musicPlayer: {
    name: N_("Big music player"),
    about: N_("The button on Spotify's card that lets the player take the whole island."),
  },
  compactSong: {
    name: N_("Song in the compact island"),
    about: N_("While a song plays: its cover, its title and how far it is, in the compact island."),
  },
  clock: {
    name: N_("Clock"),
    about: N_("The time in the compact island, while no song shows there."),
  },
  weather: {
    name: N_("Weather"),
    about: N_("The weather's icon and the temperature beside the clock, for the city you picked. Off, nothing is asked of the weather service."),
  },
  motion: {
    name: N_("Animations"),
    about: N_("How the settings window and the island's tabs move. Off, things change at once."),
  },
};

/** The modules' titles, by group id. */
const GROUP_TITLES: Record<string, string> = {
  claude: "Claude Code",
  skills: N_("Claude skills"),
  launcher: N_("Launcher"),
  jev: N_("JEV"),
  music: N_("Music · Spotify"),
  time: N_("Time and weather"),
  look: N_("Look"),
};

export const FEATURE_GROUPS: readonly { id: FeatureGroup; title: string }[] = (MANIFEST.groups as string[]).map(
  (id) => ({ id, title: GROUP_TITLES[id] ?? id }),
);

export const FEATURES: readonly FeatureDef[] = (MANIFEST.features as Entry[]).map((entry) => {
  const text = TEXT[entry.id] ?? { name: entry.id, about: "" };
  return {
    id: entry.id,
    group: entry.group,
    name: text.name,
    about: text.about,
    needs: entry.needs,
    page: entry.page,
    anchor: entry.anchor,
    tab: entry.tab ? { ...entry.tab, title: text.tab ?? text.name } : undefined,
    settingsPage: entry.settingsPage
      ? { ...entry.settingsPage, label: text.page ?? text.name }
      : undefined,
    pills: entry.pills ?? [],
  };
});

/** The words of each feature, for the tests to check every declaration has them. */
export const FEATURE_TEXT_IDS: readonly string[] = Object.keys(TEXT);

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

/** The features that add a tab to the island's header, left to right. */
export function featureTabs(): FeatureDef[] {
  return FEATURES.filter((f) => f.tab).sort((a, b) => a.tab!.order - b.tab!.order);
}

/** Whether pill `id` may be offered and shown: not when it belongs to a feature that is off. */
export function pillAllowed(settings: { disabledFeatures?: unknown }, id: string): boolean {
  return FEATURES.every((f) => !f.pills.includes(id) || featureOn(settings, f.id));
}
