// The twenty-questions tab (src/views/twenty.ts) and its words (src/core/twenty.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import "./tauri.mjs";

installFakeDom();
const { KINDS, ITEM_NAMES, answerText, itemName, progress } = await import("../src/core/twenty.ts");
const { buildTwenty } = await import("../src/views/twenty.ts");
const { State } = await import("../src/core/state.ts");

test("JEV's five answers have their words, and the good and bad ones their mood", () => {
  assert.deepEqual(answerText("yes"), { text: "Yes", mood: "ok" });
  assert.deepEqual(answerText("probablyYes"), { text: "Probably yes", mood: "ok" });
  assert.deepEqual(answerText("unsure"), { text: "Not sure", mood: "" });
  assert.deepEqual(answerText("probablyNo"), { text: "Probably not", mood: "bad" });
  assert.deepEqual(answerText("no"), { text: "No", mood: "bad" });
  assert.equal(answerText("nonsense").text, "Not sure", "an unknown answer reads as not sure");
});

test("the kinds are the ones Rust knows, and progress counts the question being asked", () => {
  assert.deepEqual(KINDS.map((k) => k.id), ["animal", "food", "thing", "any"]);
  assert.equal(progress(0, 20), "Question 1 of 20");
  assert.equal(progress(7, 20), "Question 8 of 20");
  assert.equal(progress(20, 20), "Question 20 of 20", "never past the last");
  assert.equal(itemName("Ice cream"), "Ice cream");
  assert.equal(ITEM_NAMES.length, 18);
});

test("every thing Coucou may think of can be named in the interface language", async () => {
  const { readFileSync } = await import("node:fs");
  const rust = readFileSync(new URL("../src-tauri/src/twenty.rs", import.meta.url), "utf8");
  const names = [...rust.matchAll(/\("(?:animal|food|thing)", "([^"]+)"\)/g)].map((m) => m[1]);
  assert.equal(names.length, 18);
  assert.deepEqual([...names].sort(), [...ITEM_NAMES].sort(), "twenty.rs and core/twenty.ts list the same things");
});

test("the tab starts at the choice of a kind and asks nothing by itself", () => {
  State.view = "twenty";
  const view = buildTwenty({ blip() {} });
  view.sync();
  const chips = view.el.find(".sk-chips")[0];
  assert.equal(chips.style.display, "");
  assert.equal(chips.children.length, 4);
  assert.equal(view.el.find(".sk-top")[0].style.display, "none", "no box to type in before a game");
  assert.equal(view.el.find(".sk-empty").length, 1);
});
