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
  assert.deepEqual(parts, ["skillAdvice<skillsTab", "weather<clock"]);
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
  assert.deepEqual(shown(), [true, true, true, true, true]);
  State.settings = off("launcherTab");
  header.sync();
  assert.deepEqual(shown(), [true, true, true, false, true]);
  State.settings = off("skillsTab");
  header.sync();
  assert.deepEqual(shown(), [true, true, true, true, false]);
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
