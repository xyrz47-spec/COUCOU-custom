// The Decide tab (src/views/decide.ts) and JEV's ranking in words (src/core/jev.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import "./tauri.mjs";

installFakeDom();
const { PRESETS, MAX_OPTIONS, doubt, parseOptions, percent, presetText, rows } = await import("../src/core/jev.ts");
const { buildDecide } = await import("../src/views/decide.ts");
const { DEFAULT_SETTINGS, State } = await import("../src/core/state.ts");

const decision = (shares, confidence = 0.8) => ({
  ranking: shares.map(([option, share]) => ({ option, share })),
  confidence,
});

test("options are read from lines or commas, once each, at most ten", () => {
  assert.deepEqual(parseOptions("Soup\n Salad ,pizza，SOUP\n\n"), ["Soup", "Salad", "pizza"]);
  assert.deepEqual(parseOptions("   "), []);
  const many = Array.from({ length: 15 }, (_, n) => `Dish ${n}`).join("\n");
  assert.equal(parseOptions(many).length, MAX_OPTIONS);
});

test("a preset fills the box with its options, one per line", () => {
  assert.equal(PRESETS.length, 3);
  const meal = presetText(0).split("\n");
  assert.ok(meal.length >= 5 && meal.includes("Soup"));
  assert.equal(parseOptions(presetText(1)).length, PRESETS[1].options.length);
  assert.equal(presetText(99), "");
});

test("the ranking becomes rows, the best first, each bar measured against it", () => {
  const list = rows(decision([["Soup", 0.6], ["Pizza", 0.3], ["Salad", 0.1]]));
  assert.deepEqual(list.map((r) => [r.option, r.share, r.width, r.best]), [
    ["Soup", "60%", 100, true], ["Pizza", "30%", 50, false], ["Salad", "10%", 17, false],
  ]);
  assert.equal(rows(decision([["A", 0], ["B", 0]])).every((r) => r.width === 0), true, "nothing divides by zero");
  assert.deepEqual([percent(0.456), percent(2), percent(-1)], ["46%", "100%", "0%"]);
  assert.equal(doubt(decision([["A", 0.5]], 0.8)), null);
  assert.match(doubt(decision([["A", 0.5]], 0.3)), /not very sure/);
});

test("the Decide tab starts empty, has its presets while that is on, and asks nothing by itself", () => {
  State.settings = { ...DEFAULT_SETTINGS };
  State.view = "decide";
  const view = buildDecide({ blip() {} });
  view.sync();
  assert.equal(view.el.find(".sk-empty").length, 1);
  const chips = view.el.find(".sk-chips")[0];
  assert.equal(chips.style.display, "");
  assert.equal(chips.children.length, 3);
  State.settings = { ...DEFAULT_SETTINGS, disabledFeatures: ["decidePresets"] };
  view.sync();
  assert.equal(chips.style.display, "none");
  State.settings = { ...DEFAULT_SETTINGS };
});

test("the feeling is forgotten when the tab is left", () => {
  State.settings = { ...DEFAULT_SETTINGS };
  State.view = "decide";
  const view = buildDecide({ blip() {} });
  view.sync();
  const feeling = view.el.find("input")[0];
  feeling.value = "tired";
  State.view = "overview";
  view.sync();
  assert.equal(feeling.value, "");
});
