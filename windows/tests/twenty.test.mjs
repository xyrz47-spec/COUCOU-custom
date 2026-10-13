// The twenty-questions tab (src/views/twenty.ts) and its words (src/core/twenty.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import "./tauri.mjs";

installFakeDom();
const { KINDS, answerText, progress, secretText } = await import("../src/core/twenty.ts");
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

test("the kinds are the ones Rust knows, and progress counts the question being asked", async () => {
  const { readFileSync } = await import("node:fs");
  const rust = readFileSync(new URL("../src-tauri/src/twenty.rs", import.meta.url), "utf8");
  const known = rust.match(/pub const KINDS: &\[&str\] = &\[([^\]]+)\]/)[1].match(/"(\w+)"/g).map((k) => k.slice(1, -1));
  assert.deepEqual(KINDS.map((k) => k.id), [...known, "any"]);
  assert.equal(progress(0, 20), "Question 1 of 20");
  assert.equal(progress(7, 20), "Question 8 of 20");
  assert.equal(progress(20, 20), "Question 20 of 20", "never past the last");
});

test("the secret is told in the interface language with the English beside it", () => {
  const secret = { en: "Elephant", names: { en: "Elephant", ko: "코끼리", fr: "Éléphant", "zh-Hans": "大象", "pt-BR": "Elephant" } };
  assert.equal(secretText(secret, "ko"), "코끼리 (Elephant)");
  assert.equal(secretText(secret, "fr"), "Éléphant (Elephant)");
  assert.equal(secretText(secret, "zh-Hans"), "大象 (Elephant)");
  assert.equal(secretText(secret, "en"), "Elephant");
  assert.equal(secretText(secret, "pt-BR"), "Elephant", "the same name is not said twice");
  assert.equal(secretText(secret, "ru"), "Elephant", "a missing name falls back to English");
});

test("with Pokémon pictures off, the emoji stays and nothing is fetched", async () => {
  const { internals } = await import("./tauri.mjs");
  const { DEFAULT_SETTINGS } = await import("../src/core/state.ts");
  const before = internals.invoke;
  const asked = [];
  internals.invoke = async (cmd, args) => {
    asked.push(cmd);
    if (cmd === "twenty_new") return { total: 20, pool: 10 };
    if (cmd === "twenty_give_up") return { en: "Pikachu", emoji: "⚡", art: true, names: { en: "Pikachu" } };
    if (cmd === "twenty_picture") return "data:image/png;base64,AAAA";
    return before(cmd, args);
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  try {
    State.settings = { ...DEFAULT_SETTINGS, disabledFeatures: ["twentyPictures"] };
    const view = buildTwenty({ blip() {} });
    view.el.find(".tq-kind")[0].fire("click");
    await tick();
    view.el.find(".tq-btn").find((b) => b.classList.contains("danger")).fire("click");
    await tick();
    await tick();
    assert.equal(view.el.find(".tq-pic")[0].textContent, "⚡");
    assert.equal(view.el.find("IMG").length, 0);
    assert.ok(!asked.includes("twenty_picture"));
  } finally {
    internals.invoke = before;
    State.settings = { ...State.settings, disabledFeatures: [] };
  }
});

test("the tab starts at the choice of a kind and asks nothing by itself", () => {
  State.view = "twenty";
  const view = buildTwenty({ blip() {} });
  view.sync();
  assert.equal(view.el.find(".tq-start")[0].style.display, "");
  assert.equal(view.el.find(".tq-kind").length, 11, "ten kinds and anything");
  assert.equal(view.el.find(".tq-game")[0].style.display, "none", "no box to type in before a game");
  assert.equal(view.el.find(".tq-title").length, 1);
});

test("a game: twenty dots coloured by the answers, then the secret on its card in the interface language", async () => {
  const { internals } = await import("./tauri.mjs");
  const started = [];
  const before = internals.invoke;
  const answers = ["yes", "no"];
  internals.invoke = async (cmd, args) => {
    if (cmd === "twenty_new") {
      started.push(args);
      return { total: 20, pool: 1122 };
    }
    if (cmd === "twenty_ask") return { label: answers.shift(), asked: 2 - answers.length, left: 18 + answers.length, over: false, secret: null };
    if (cmd === "twenty_give_up") return { en: "Rhydon", emoji: "⛰️", art: true, names: { en: "Rhydon", ko: "코뿌리" } };
    if (cmd === "twenty_picture") return "data:image/png;base64,iVBORw0KGgo=";
    return before(cmd, args);
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  try {
    State.view = "twenty";
    const view = buildTwenty({ blip() {} });
    view.el.find(".tq-kind").find((k) => k.dataset.kind === "pokemon").fire("click");
    await tick();
    assert.deepEqual(started, [{ kind: "pokemon" }], "the kind only: there is no level");
    assert.equal(view.el.find(".tq-start")[0].style.display, "none");
    assert.equal(view.el.find(".tq-dot").length, 20);
    assert.equal(view.el.find(".tq-badge")[0].textContent, "A Pokémon");
    const input = view.el.find(".tq-input")[0];
    for (const q of ["Is it from Kanto?", "Can it fly?"]) {
      input.value = q;
      view.el.find(".tq-btn")[0].fire("click");
      await tick();
    }
    const dots = view.el.find(".tq-dot");
    assert.ok(dots[0].classList.contains("yes") && dots[1].classList.contains("no"));
    assert.ok(dots[2].classList.contains("now"), "the question being asked");
    assert.deepEqual(view.el.find(".tq-q").map((q) => q.textContent), ["Can it fly?", "Is it from Kanto?"], "the latest first");
    view.el.find(".tq-btn").find((b) => b.classList.contains("danger")).fire("click");
    await tick();
    assert.equal(view.el.find(".tq-card-name")[0].textContent, "Rhydon");
    await tick();
    const img = view.el.find("IMG")[0];
    assert.ok(img, "the Pokémon's artwork replaces its emoji once fetched");
    assert.equal(img.getAttribute("src"), "data:image/png;base64,iVBORw0KGgo=");
    assert.equal(view.el.find(".tq-ask")[0].style.display, "none", "no more questions once it is over");
  } finally {
    internals.invoke = before;
  }
});
