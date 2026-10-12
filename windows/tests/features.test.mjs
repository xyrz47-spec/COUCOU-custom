// Settings → Features (src/core/features.ts): what a switch means, what is
// saved for it, and that the island follows — the chat's picker, the header's
// tabs, the skills tab's "Suggest", Spotify's big player.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import "./tauri.mjs";

installFakeDom();
const {
  FEATURES, FEATURE_GROUPS, MAX_DISABLED, featureCount, featureOn, featureSwitch, isFeature, withFeature,
} = await import("../src/core/features.ts");
const { visibleProviders } = await import("../src/core/providers.ts");
const { DEFAULT_SETTINGS, State } = await import("../src/core/state.ts");
const { Spotify, SPOTIFY_ID } = await import("../src/core/spotify.ts");
const { buildHeader } = await import("../src/views/views.ts");
const { buildSkills } = await import("../src/views/skills.ts");

const off = (...ids) => ({ ...DEFAULT_SETTINGS, disabledFeatures: ids });

test("everything is on until it is turned off, and only what is off is saved", () => {
  assert.deepEqual(DEFAULT_SETTINGS.disabledFeatures, []);
  for (const def of FEATURES) assert.ok(featureOn(DEFAULT_SETTINGS, def.id), def.id);
  assert.deepEqual(featureCount(DEFAULT_SETTINGS), { on: FEATURES.length, of: FEATURES.length });
  assert.deepEqual(withFeature(DEFAULT_SETTINGS, "weather", false), ["weather"]);
  assert.deepEqual(withFeature(off("weather"), "weather", true), []);
  // In the catalog's order, each once, whatever order they were turned off in.
  assert.deepEqual(withFeature(off("motion", "motion", "clock"), "skillsTab", false), ["skillsTab", "clock", "motion"]);
  assert.deepEqual(featureCount(off("clock", "motion")), { on: FEATURES.length - 2, of: FEATURES.length });
  assert.ok(FEATURES.length < MAX_DISABLED);
});

test("a settings file from elsewhere turns nothing off by accident", () => {
  // No list at all (saved before features could be turned off), or not a list.
  assert.ok(featureOn({}, "clock"));
  assert.ok(featureOn({ disabledFeatures: "clock" }, "clock"));
  assert.ok(featureOn({ disabledFeatures: null }, "weather"));
  // An id this build doesn't know is dropped at the next change.
  assert.deepEqual(withFeature({ disabledFeatures: ["teleport", 3, "clock"] }, "motion", false), ["clock", "motion"]);
  assert.ok(isFeature("clock") && !isFeature("teleport") && !isFeature(undefined));
});

test("a feature that is part of another is off with it, its own switch kept", () => {
  const parts = FEATURES.filter((def) => def.needs).map((def) => `${def.id}<${def.needs}`);
  assert.deepEqual(parts, ["pluginSkills<skillsTab", "skillFind<skillsTab", "skillAdvice<skillsTab", "launcherApps<launcherTab", "launcherFavicons<launcherTab", "decidePresets<decide", "decideRemember<decide", "musicPlayer<spotify", "compactSong<spotify", "spotifyDance<spotify", "songAnnounce<spotify", "weather<clock"]);
  const settings = off("clock");
  assert.equal(featureOn(settings, "weather"), false);
  assert.equal(featureSwitch(settings, "weather"), true);
  assert.equal(featureOn(off("skillsTab"), "skillAdvice"), false);
  assert.equal(featureOn(off("skillAdvice"), "skillsTab"), true);
});

test("every feature has a name, a line about it and a group with a title", () => {
  const groups = FEATURE_GROUPS.map((group) => group.id);
  const ids = new Set();
  for (const def of FEATURES) {
    assert.ok(def.name && def.about.endsWith("."), def.id);
    assert.ok(groups.includes(def.group), def.id);
    assert.ok(!ids.has(def.id), def.id);
    ids.add(def.id);
  }
  for (const group of FEATURE_GROUPS) assert.ok(FEATURES.some((def) => def.group === group.id), group.id);
});

test("Claude Code leaves the chat's picker when turned off, unless the chat is on it", () => {
  const ids = (s) => visibleProviders(s).map((p) => p.id);
  assert.deepEqual(ids(off("claudeChat")), ["anthropic", "google", "openai", "openrouter"]);
  assert.equal(ids({ ...off("claudeChat"), chatProvider: "claude-code" })[0], "claude-code");
  assert.equal(ids(off("weather"))[0], "claude-code");
});

test("the header shows the launcher's and the skills' tabs while they are on", () => {
  State.settings = { ...DEFAULT_SETTINGS };
  const header = buildHeader({ blip: () => {}, setView: () => {}, toggleSound: () => {} });
  const tabs = header.el.find(".tab");
  const shown = () => tabs.map((tab) => tab.style.display !== "none");
  header.sync();
  assert.deepEqual(shown(), [true, true, true, true, true, true]);
  State.settings = off("launcherTab");
  header.sync();
  assert.deepEqual(shown(), [true, true, true, false, true, true]);
  State.settings = off("skillsTab");
  header.sync();
  assert.deepEqual(shown(), [true, true, true, true, false, true]);
  State.settings = off("decide");
  header.sync();
  assert.deepEqual(shown(), [true, true, true, true, true, false]);
  State.settings = { ...DEFAULT_SETTINGS };
});

test("\"Suggest\" leaves the skills tab when turned off, and comes back", async () => {
  State.settings = { ...DEFAULT_SETTINGS };
  State.mode = "expanded";
  State.view = "skills";
  const view = buildSkills({ blip: () => {}, openUrl: () => {} });
  view.sync();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const tabs = view.el.find(".sk-seg")[0].children;
  tabs[2].fire("click");
  assert.ok(tabs[2].classList.contains("on"));
  State.settings = off("skillAdvice");
  view.sync();
  assert.equal(tabs[2].style.display, "none");
  // The plan's tab was open: the installed skills take its place.
  assert.ok(tabs[0].classList.contains("on"));
  assert.equal(view.el.querySelector(".sk-ask").style.display, "none");
  State.settings = { ...DEFAULT_SETTINGS };
  view.sync();
  assert.equal(tabs[2].style.display, "");
});

test("Spotify's big player is not shown while its feature is off", () => {
  const before = { player: Spotify.player, track: Spotify.state.track, tasks: State.tasks, focus: State.focusId };
  State.settings = { ...DEFAULT_SETTINGS };
  State.mode = "expanded";
  State.view = "overview";
  State.tasks = [{ id: SPOTIFY_ID, name: "Spotify", color: "#1DB954", state: "idle", stepIndex: 0, steps: [], source: "agent", isIntegration: true }];
  State.focusId = SPOTIFY_ID;
  Spotify.player = true;
  Spotify.state.track = { title: "Song", artist: "Someone", duration: 180 };
  assert.equal(State.spotifyPlayerShown, true);
  State.settings = off("musicPlayer");
  assert.equal(State.spotifyPlayerShown, false);
  Spotify.player = before.player;
  Spotify.state.track = before.track;
  State.tasks = before.tasks;
  State.focusId = before.focus;
  State.settings = { ...DEFAULT_SETTINGS };
});

// ── The manager: features.json is the one declaration ────────────────────────

test("every declaration has its words, and every word a declaration", async () => {
  const { FEATURE_TEXT_IDS } = await import("../src/core/features.ts");
  assert.deepEqual([...FEATURE_TEXT_IDS].sort(), FEATURES.map((f) => f.id).sort());
});

test("a feature only asks for what exists: a parent, an icon, a pill, a page of its own once", async () => {
  const { ICONS } = await import("../src/views/icons.ts");
  const { PILL_CATALOG } = await import("../src/core/pills.ts");
  const ids = new Set(FEATURES.map((f) => f.id));
  const pages = new Set();
  const views = new Set();
  for (const f of FEATURES) {
    if (f.needs) assert.ok(ids.has(f.needs) && f.needs !== f.id, f.id);
    if (f.tab) {
      assert.ok(ICONS[f.tab.icon], `${f.id}: icon ${f.tab.icon}`);
      assert.ok(!views.has(f.tab.view), `${f.id}: view used twice`);
      views.add(f.tab.view);
    }
    if (f.settingsPage) {
      assert.ok(!pages.has(f.settingsPage.id), `${f.id}: page used twice`);
      pages.add(f.settingsPage.id);
    }
    for (const pill of f.pills) assert.ok(PILL_CATALOG.some((p) => p.id === pill), `${f.id}: pill ${pill}`);
  }
  // No parent chain loops.
  for (const f of FEATURES) {
    let at = f;
    for (let n = 0; n <= FEATURES.length; n++) {
      if (!at.needs) break;
      at = FEATURES.find((o) => o.id === at.needs);
      assert.ok(n < FEATURES.length, `${f.id}: loop`);
    }
  }
});

test("the code only checks features that are declared", async () => {
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const ids = new Set(FEATURES.map((f) => f.id));
  const walk = (dir) => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : [];
  });
  const used = [];
  for (const file of walk(new URL("../src", import.meta.url).pathname)) {
    for (const m of readFileSync(file, "utf8").matchAll(/\b(?:featureOn|featureSwitch|featureDef)\([^,)]*,?\s*"(\w+)"\)/g)) used.push([file, m[1]]);
  }
  assert.ok(used.length > 10);
  for (const [file, id] of used) assert.ok(ids.has(id), `${file}: ${id}`);
});

test("the header's tabs and the island's checks follow the declarations, in order", async () => {
  const { featureTabs } = await import("../src/core/features.ts");
  assert.deepEqual(featureTabs().map((f) => f.tab.view), ["launcher", "skills", "decide"]);
});

test("Spotify off takes its pill and the music features with it, and keeps what was declared", async () => {
  const { sanitizeDeclared } = await import("../src/core/pills.ts");
  const { pillAllowed } = await import("../src/core/features.ts");
  const declared = { mainPill: "integration_vscode", activeIntegrations: ["integration_spotify"] };
  assert.deepEqual(sanitizeDeclared({ ...declared, disabledFeatures: [] }, "windows").activeIntegrations, ["integration_spotify"]);
  assert.deepEqual(sanitizeDeclared({ ...declared, disabledFeatures: ["spotify"] }, "windows").activeIntegrations, []);
  assert.equal(pillAllowed(off("spotify"), "integration_spotify"), false);
  assert.equal(pillAllowed(off("spotify"), "integration_github"), true);
  assert.equal(featureOn(off("spotify"), "musicPlayer"), false);
  assert.equal(featureOn(off("spotify"), "compactSong"), false);
  // The declaration itself is untouched: turn it back on and the pill is there.
  assert.deepEqual(declared.activeIntegrations, ["integration_spotify"]);
});

// ── The finer switches: each one really changes something ────────────────────

test("\"Find skills\" off takes the Find tab and its chips out of the skills tab", async () => {
  State.settings = off("skillFind");
  State.mode = "expanded";
  State.view = "skills";
  const view = buildSkills({ blip: () => {}, openUrl: () => {} });
  view.sync();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const tabs = view.el.find(".sk-seg")[0].children;
  assert.equal(tabs[1].style.display, "none", "the Find tab");
  assert.equal(view.el.find(".sk-chips")[0].style.display, "none", "the fields to pick from");
  assert.equal(tabs[0].style.display === "none", false, "Installed stays");
  State.settings = { ...DEFAULT_SETTINGS };
  view.sync();
  assert.equal(tabs[1].style.display, "");
});

test("\"Plan usage\" off keeps the plan pills out of the header, whatever the other settings say", async () => {
  const { claudePillVisible, codexPillVisible } = await import("../src/views/usage.ts");
  State.view = "overview";
  State.settings = { ...DEFAULT_SETTINGS, showPlanInNotch: true, planRelayInstalled: true, showCodexPlanInNotch: true };
  assert.equal(claudePillVisible() && codexPillVisible(), true);
  State.settings = { ...State.settings, disabledFeatures: ["planUsage"] };
  assert.equal(claudePillVisible() || codexPillVisible(), false);
  State.settings = { ...DEFAULT_SETTINGS };
});

test("\"Mochi dances\" off stops the dancing but not the music", () => {
  State.settings = { ...DEFAULT_SETTINGS };
  const playing = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(State), "spotifyPlaying");
  Object.defineProperty(State, "spotifyPlaying", { get: () => true, configurable: true });
  assert.equal(State.mochiDances, true);
  State.settings = off("spotifyDance");
  assert.equal(State.mochiDances, false);
  assert.equal(State.spotifyPlaying, true);
  State.settings = off("spotify");
  assert.equal(State.mochiDances, false, "off with Spotify");
  delete State.spotifyPlaying;
  if (playing) Object.defineProperty(Object.getPrototypeOf(State), "spotifyPlaying", playing);
  State.settings = { ...DEFAULT_SETTINGS };
});

test("the manager has many small switches, grouped in modules, none of them alone in the dark", () => {
  assert.ok(FEATURES.length >= 20, `${FEATURES.length} features`);
  assert.ok(FEATURE_GROUPS.length >= 7);
  for (const group of FEATURE_GROUPS) assert.ok(FEATURES.some((f) => f.group === group.id), group.id);
});
