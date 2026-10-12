// The Check tab (src/views/check.ts) and JEV's read in words (src/core/jev.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import "./tauri.mjs";

installFakeDom();
const { describe, percent } = await import("../src/core/jev.ts");
const { buildCheck } = await import("../src/views/check.ts");
const { State } = await import("../src/core/state.ts");

const read = (over = {}) => ({ tone: "friendly", toneConfidence: 0.9, urgency: 0, urgencyConfidence: 1, needsReply: 0.1, rude: 0.02, ...over });
const byLabel = (lines) => Object.fromEntries(lines.map((l) => [l.label, l]));

test("a read becomes four short lines", () => {
  const lines = byLabel(describe(read()));
  assert.deepEqual(Object.keys(lines), ["Sounds", "Urgency", "Reply", "Could sound rude"]);
  assert.deepEqual(lines.Sounds, { label: "Sounds", value: "friendly", mood: "good" });
  assert.equal(lines.Urgency.value, "not urgent");
  assert.equal(lines.Reply.value, "none needed (10%)");
  assert.equal(lines["Could sound rude"].value, "no (2%)");
});

test("urgency, reply and rudeness change the words and the mood at their thresholds", () => {
  const urgency = (n) => byLabel(describe(read({ urgency: n }))).Urgency;
  assert.deepEqual([urgency(0.4).value, urgency(0.5).value, urgency(1.4).value, urgency(1.5).value], ["not urgent", "soon", "soon", "urgent"]);
  assert.equal(urgency(2).mood, "warn");
  const reply = byLabel(describe(read({ needsReply: 0.92 }))).Reply;
  assert.deepEqual([reply.value, reply.mood], ["asks for an answer (92%)", "watch"]);
  const rude = byLabel(describe(read({ rude: 0.7 })))["Could sound rude"];
  assert.deepEqual([rude.value, rude.mood], ["yes (70%)", "warn"]);
});

test("a tone is named only when JEV is sure of it, and a stern or upset one is flagged", () => {
  const sounds = (over) => byLabel(describe(read(over))).Sounds;
  assert.equal(sounds({ tone: "stern", toneConfidence: 0.8 }).mood, "watch");
  assert.equal(sounds({ tone: "upset", toneConfidence: 0.8 }).value, "upset");
  assert.equal(sounds({ tone: "stern", toneConfidence: 0.2 }).value, "hard to tell");
  assert.equal(sounds({ tone: "", toneConfidence: 0.9 }).value, "hard to tell");
  assert.equal(sounds({ tone: "sarcastic", toneConfidence: 0.9 }).value, "hard to tell");
  assert.deepEqual([percent(0.456), percent(2), percent(-1)], ["46%", "100%", "0%"]);
});

test("the Check tab starts empty, asks nothing by itself and forgets the message when left", () => {
  State.view = "check";
  const view = buildCheck({ blip() {} });
  const box = view.el.find("textarea")[0];
  assert.ok(view.el.find(".sk-empty").length === 1);
  box.value = "Can you send the report today?";
  State.view = "overview";
  view.sync();
  assert.equal(box.value, "", "nothing is kept once the tab is left");
});
