// The twenty-questions tab (src/views/twenty.ts) and its words (src/core/twenty.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import "./tauri.mjs";

installFakeDom();
const { KINDS, LEVELS, answerText, progress, secretText } = await import("../src/core/twenty.ts");
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

test("the kinds and levels are the ones Rust knows, and progress counts the question being asked", async () => {
  const { readFileSync } = await import("node:fs");
  const rust = readFileSync(new URL("../src-tauri/src/twenty.rs", import.meta.url), "utf8");
  const known = rust.match(/pub const KINDS: &\[&str\] = &\[([^\]]+)\]/)[1].match(/"(\w+)"/g).map((k) => k.slice(1, -1));
  assert.deepEqual(KINDS.map((k) => k.id), [...known, "any"]);
  assert.deepEqual(LEVELS.map((l) => l.id), ["easy", "normal", "hard", "any"]);
  assert.equal(progress(0, 20), "Question 1 of 20");
  assert.equal(progress(7, 20), "Question 8 of 20");
  assert.equal(progress(20, 20), "Question 20 of 20", "never past the last");
});

test("the secret is told in Korean with the English beside it on a Korean interface, else in English", () => {
  const secret = { en: "Elephant", ko: "코끼리" };
  assert.equal(secretText(secret, "ko"), "코끼리 (Elephant)");
  for (const lang of ["en", "fr", "zh-Hans"]) assert.equal(secretText(secret, lang), "Elephant");
});

test("the tab starts at the choice of a kind and asks nothing by itself", () => {
  State.view = "twenty";
  const view = buildTwenty({ blip() {} });
  view.sync();
  const [levels, chips] = view.el.find(".sk-chips");
  assert.equal(chips.style.display, "");
  assert.equal(chips.children.length, 7, "six kinds and anything");
  assert.equal(levels.children.length, 4, "the levels");
  assert.equal(view.el.find(".sk-top")[0].style.display, "none", "no box to type in before a game");
  assert.equal(view.el.find(".sk-empty").length, 1);
});
