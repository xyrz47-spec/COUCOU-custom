// The chat view (src/views/chat.ts) on a fake DOM, through the real bridge:
// the model switcher asks for a provider's models only once it is picked and
// has a key, picking saves the settings, and a streamed answer grows in place.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { calls, emit, internals, sent } from "./tauri.mjs";

installFakeDom();
const { buildPrompt } = await import("../src/views/chat.ts");
const { DEFAULT_SETTINGS, State } = await import("../src/core/state.ts");

/** What the mocked Rust side answers, by command. */
let answers;
const plainInvoke = internals.invoke;
internals.invoke = async (cmd, args) => {
  const result = await plainInvoke(cmd, args);
  if (cmd in answers) return typeof answers[cmd] === "function" ? answers[cmd](args) : answers[cmd];
  return result;
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let view;
beforeEach(() => {
  calls.length = 0;
  answers = {};
  State.settings = { ...DEFAULT_SETTINGS, chatModels: {} };
  State.chatHistory = [];
  State.stateOverride = null;
  State.view = "prompt";
  State.droppedFile = null;
  State.chatPicking = false;
  view = buildPrompt(() => {});
  view.sync();
});

const $ = (cls) => view.el.querySelector(cls);
const chips = () => view.el.find(".picker-chip").map((c) => c.textContent);
const models = () => view.el.find(".picker-model").map((m) => m.textContent);

test("the model button shows the active provider's model", () => {
  assert.equal($(".model-name").textContent, "claude-opus-5");
  State.settings = { ...State.settings, chatProvider: "google" };
  view.sync();
  assert.equal($(".model-name").textContent, "gemini-2.0-flash");
  State.settings = { ...State.settings, chatProvider: "ollama" };
  view.sync();
  assert.equal($(".model-name").textContent, "Choose a model");
});

test("a provider without a key is never asked for its models", async () => {
  answers.secret_present = false;
  $(".model-btn").fire("click");
  await flush();
  assert.ok($(".chat-body").classList.contains("picking"));
  assert.deepEqual(chips(), ["Claude Code", "Anthropic", "Google", "OpenAI", "OpenRouter"]);
  assert.deepEqual(sent("secret_present"), [{ key: "anthropic-api-key" }]);
  assert.deepEqual(sent("chat_models"), []);
  assert.match($(".picker-status").textContent, /No API key/);
});

test("with a key, the models are listed and picking one saves it", async () => {
  answers.secret_present = true;
  answers.chat_models = [
    { id: "claude-opus-5", label: "Claude Opus 5" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
  ];
  $(".model-btn").fire("click");
  await flush();
  assert.deepEqual(sent("chat_models"), [{ provider: "anthropic" }]);
  assert.deepEqual(models(), ["Claude Opus 5", "Claude Sonnet 5"]);
  view.el.find(".picker-model")[1].fire("click");
  assert.equal(State.settings.model, "claude-sonnet-5");
  assert.equal(sent("save_settings").at(-1).settings.model, "claude-sonnet-5");
  assert.ok(!$(".chat-body").classList.contains("picking"));
  assert.equal($(".model-name").textContent, "claude-sonnet-5");
});

test("Claude Code needs no key: its models are listed without one being asked for", async () => {
  answers.secret_present = false;
  answers.chat_models = [{ id: "opus", label: "Opus" }, { id: "sonnet", label: "Sonnet" }, { id: "haiku", label: "Haiku" }];
  State.settings = { ...State.settings, chatProvider: "claude-code" };
  view.sync();
  assert.equal($(".model-name").textContent, "sonnet");
  $(".model-btn").fire("click");
  await flush();
  assert.deepEqual(sent("secret_present"), []);
  assert.deepEqual(sent("chat_models"), [{ provider: "claude-code" }]);
  assert.deepEqual(models(), ["Opus", "Sonnet", "Haiku"]);
  view.el.find(".picker-model")[0].fire("click");
  assert.equal(State.settings.chatModels["claude-code"], "opus");
  // Claude's API model is another setting, and is left alone.
  assert.equal(State.settings.model, "claude-opus-5");
  assert.equal($(".model-name").textContent, "opus");
});

test("the open picker takes the island's full height, and gives it back", async () => {
  answers.secret_present = false;
  let resized = 0;
  view = buildPrompt(() => resized++);
  view.sync();
  $(".model-btn").fire("click");
  await flush();
  assert.equal(State.chatPicking, true);
  assert.equal(resized, 1);
  $(".model-btn").fire("click");
  assert.equal(State.chatPicking, false);
  assert.equal(resized, 2);
});

test("Claude Code can be told how hard to think; the others are not asked", async () => {
  answers.secret_present = false;
  answers.chat_models = [{ id: "sonnet", label: "Sonnet" }];
  $(".model-btn").fire("click");
  await flush();
  // Anthropic's API chat takes no effort: no levels are offered.
  assert.ok(!$(".picker-effort").classList.contains("on"));
  assert.deepEqual(view.el.find(".picker-effort-btn"), []);

  view.el.find(".picker-chip")[0].fire("click");
  await flush();
  assert.equal(State.settings.chatProvider, "claude-code");
  assert.ok($(".picker-effort").classList.contains("on"));
  const levels = () => view.el.find(".picker-effort-btn");
  assert.deepEqual(levels().map((b) => b.textContent), ["Default", "Low", "Medium", "High", "Very high", "Max"]);
  assert.ok(levels()[0].classList.contains("on"));
  levels()[3].fire("click");
  assert.equal(State.settings.chatEffort, "high");
  assert.equal(sent("save_settings").at(-1).settings.chatEffort, "high");
  assert.ok(levels()[3].classList.contains("on") && !levels()[0].classList.contains("on"));
  // Picking a level leaves the picker open, and the model button says it.
  assert.ok($(".chat-body").classList.contains("picking"));
  assert.equal($(".model-name").textContent, "sonnet · High");
});

test("switching provider saves it and asks the new provider only", async () => {
  answers.secret_present = (args) => args.key === "google-api-key";
  answers.chat_models = (args) => (args.provider === "google" ? [{ id: "gemini-2.5-flash", label: "gemini-2.5-flash" }] : []);
  $(".model-btn").fire("click");
  await flush();
  assert.deepEqual(sent("chat_models"), []);
  view.el.find(".picker-chip")[2].fire("click");
  await flush();
  assert.equal(State.settings.chatProvider, "google");
  assert.deepEqual(sent("chat_models"), [{ provider: "google" }]);
  // The saved model was not offered: the flash one is kept instead, and saved.
  assert.equal(State.settings.chatModels.google, "gemini-2.5-flash");
  assert.equal(sent("save_settings").at(-1).settings.chatModels.google, "gemini-2.5-flash");
  assert.deepEqual(models(), ["gemini-2.5-flash"]);
});

test("a local answer streams into one reply, then the finished text replaces it", async () => {
  let finish;
  answers.chat_send = () => new Promise((resolve) => (finish = resolve));
  const input = $(".chat-input");
  input.value = "hello";
  $(".send-btn").fire("click");
  await flush();
  view.sync(); // what State.notify() does in the island
  assert.ok($(".model-btn").disabled, "no switching mid-answer");
  assert.ok($(".typing"), "dots until the first visible text");

  emit("chat-delta", ""); // still thinking
  assert.ok($(".typing"));
  emit("chat-delta", "Hel");
  emit("chat-delta", "Hello **there**");
  view.sync(); // another view update mid-stream must not wipe the live answer
  assert.equal($(".typing"), null);
  const replies = view.el.find(".reply");
  assert.equal(replies.length, 1);
  assert.equal(replies[0].find("STRONG")[0].textContent, "there");

  finish({ text: "Hello **there**!" });
  await flush();
  view.sync();
  assert.equal(view.el.find(".reply").length, 1);
  assert.equal(view.el.find(".reply")[0].textContent, "Hello there!");
  assert.deepEqual(State.chatHistory.map((m) => m.role), ["user", "assistant"]);
  assert.ok(!$(".model-btn").disabled);
});
