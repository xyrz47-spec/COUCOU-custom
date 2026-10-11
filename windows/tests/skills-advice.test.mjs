// The Skills tab's "Suggest" (src/views/skills.ts) on a fake DOM, through the
// real bridge: Claude Code's plan is shown, nothing changes until it is
// applied, and only the ticked lines are.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { calls, emit, internals, sent } from "./tauri.mjs";

installFakeDom();
const { buildSkills } = await import("../src/views/skills.ts");
const { State } = await import("../src/core/state.ts");

let answers;
const plainInvoke = internals.invoke;
internals.invoke = async (cmd, args) => {
  const result = await plainInvoke(cmd, args);
  if (cmd in answers) return typeof answers[cmd] === "function" ? answers[cmd](args) : answers[cmd];
  return result;
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const PLAN = {
  add: [
    { source: "anthropics/skills", skillId: "frontend-design", name: "frontend-design", installs: 5200, verified: true, dest: "", reason: "Serves the UI work." },
    { source: "someone/skills", skillId: "react-tests", name: "react-tests", installs: 40, verified: false, dest: "", reason: "Covers the tests." },
  ],
  remove: [{ path: "C:\\p\\.claude\\skills\\old-design", name: "old-design", dest: "", reason: "Replaced by frontend-design." }],
  note: "Two in, one out.",
};

let view;
const $ = (cls) => view.el.querySelector(cls);
const rows = () => view.el.find(".sk-plan");
const tab = (index) => view.el.find(".sk-seg")[0].children[index];

beforeEach(async () => {
  calls.length = 0;
  answers = { skills_list: [], skills_projects: ["C:\\p"], skills_advise: PLAN };
  State.mode = "expanded";
  State.view = "skills";
  view = buildSkills({ blip: () => {}, openUrl: () => {} });
  view.sync();
  await flush();
  tab(2).fire("click");
});

test("a plan is asked for the folder chosen, and asking changes nothing", async () => {
  assert.match($(".sk-plan-help").textContent, /Nothing changes until you apply/);
  $(".sk-search").value = "React UI and tests";
  $(".sk-ask").fire("click");
  assert.match($(".sk-thinking").textContent, /Reading the project/);
  emit("skills-advice-step", "choosing");
  assert.match($(".sk-thinking").textContent, /Claude Code is choosing/);
  await flush();
  assert.deepEqual(sent("skills_advise"), [{ request: "React UI and tests", dest: "", verifiedOnly: true }]);
  assert.equal($(".sk-plan-note").textContent, "Two in, one out.");
  assert.equal(rows().length, 3);
  assert.match(rows()[0].textContent, /frontend-design.*Add.*Verified.*Serves the UI work\./);
  assert.match(rows()[2].textContent, /old-design.*Remove.*Replaced by frontend-design\./);
  assert.equal($(".sk-apply").textContent, "Apply 3");
  assert.deepEqual(sent("skill_install"), []);
  assert.deepEqual(sent("skill_remove"), []);
});

test("only the ticked lines are applied: added first, then removed", async () => {
  $(".sk-search").value = "React UI";
  $(".sk-ask").fire("click");
  await flush();
  // The second skill is left out.
  rows()[1].querySelector(".sk-switch").fire("click");
  assert.ok(rows()[1].classList.contains("off"));
  assert.equal($(".sk-apply").textContent, "Apply 2");
  $(".sk-apply").fire("click");
  await flush();
  await flush();
  assert.deepEqual(sent("skill_install"), [{ source: "anthropics/skills", skillId: "frontend-design", dest: "" }]);
  assert.deepEqual(sent("skill_remove"), [{ path: "C:\\p\\.claude\\skills\\old-design" }]);
  const order = calls.map(([name]) => name).filter((name) => name === "skill_install" || name === "skill_remove");
  assert.deepEqual(order, ["skill_install", "skill_remove"]);
  assert.match($(".sk-note").textContent, /Done: 1 added, 1 removed\./);
  assert.match(rows()[0].textContent, /Added/);
  assert.match(rows()[2].textContent, /Removed/);
});

test("when a skill cannot be added, nothing is removed", async () => {
  answers.skill_install = () => {
    throw new Error("GitHub answered 404");
  };
  $(".sk-search").value = "React UI";
  $(".sk-ask").fire("click");
  await flush();
  $(".sk-apply").fire("click");
  await flush();
  await flush();
  assert.equal(sent("skill_install").length, 2);
  assert.deepEqual(sent("skill_remove"), []);
  assert.match($(".sk-note").textContent, /could not be added, so none was removed/);
  assert.match(rows()[0].textContent, /GitHub answered 404/);
});

test("no change to make is said, with no button to apply", async () => {
  answers.skills_advise = { add: [], remove: [], note: "All good." };
  $(".sk-search").value = "React UI";
  $(".sk-ask").fire("click");
  await flush();
  assert.equal(rows().length, 0);
  assert.match(view.el.textContent, /All good\..*Nothing to change/);
  assert.equal($(".sk-apply").style.display, "none");
});

test("why a plan could not be made is said", async () => {
  answers.skills_advise = () => {
    throw new Error("Claude Code isn't installed on this computer.");
  };
  $(".sk-search").value = "React UI";
  $(".sk-ask").fire("click");
  await flush();
  assert.match($(".sk-note").textContent, /isn't installed/);
  assert.ok($(".sk-note").classList.contains("err"));
  assert.equal(rows().length, 0);
});

test("a line about another folder says which, and is applied there", async () => {
  answers.skills_advise = {
    add: [{ source: "anthropics/skills", skillId: "pdf", name: "pdf", installs: 9, verified: true, dest: "C:\\p", reason: "Asked for the project too." }],
    remove: [{ path: "C:\\p\\.claude\\skills\\old", name: "old", dest: "C:\\p", reason: "Asked to tidy it." }],
    note: "",
  };
  $(".sk-search").value = "PDFs, and tidy project p too";
  $(".sk-ask").fire("click");
  await flush();
  // The plan is for the user's own skills: both lines are about another folder.
  assert.deepEqual(view.el.find(".where").map((tag) => tag.textContent), ["p", "p"]);
  $(".sk-apply").fire("click");
  await flush();
  assert.deepEqual(sent("skill_install"), [{ source: "anthropics/skills", skillId: "pdf", dest: "C:\\p" }]);
  assert.deepEqual(sent("skill_remove"), [{ path: "C:\\p\\.claude\\skills\\old" }]);
});

test("any folder can be picked as a project, and is remembered", async () => {
  const { DEFAULT_SETTINGS } = await import("../src/core/state.ts");
  State.settings = { ...DEFAULT_SETTINGS, skillFolders: [] };
  answers.skills_pick_folder = "D:\\games\\modpack";
  answers.skills_projects = () => ["C:\\p", ...State.settings.skillFolders];
  const where = $(".sk-where");
  const options = () => where.children.map((option) => option.textContent);
  assert.equal(options().at(-1), "Choose a folder…");
  where.value = where.children.at(-1).getAttribute("value");
  where.fire("change");
  await flush();
  await flush();
  assert.deepEqual(State.settings.skillFolders, ["D:\\games\\modpack"]);
  assert.deepEqual(sent("save_settings").at(-1).settings.skillFolders, ["D:\\games\\modpack"]);
  assert.ok(options().includes("modpack"));
  assert.equal(where.value, "D:\\games\\modpack");
  // A plan asked for now is for that folder.
  $(".sk-search").value = "KubeJS scripts";
  $(".sk-ask").fire("click");
  await flush();
  assert.equal(sent("skills_advise").at(-1).dest, "D:\\games\\modpack");
});

test("closing the folder window without a choice changes nothing", async () => {
  const { DEFAULT_SETTINGS } = await import("../src/core/state.ts");
  State.settings = { ...DEFAULT_SETTINGS, skillFolders: [] };
  answers.skills_pick_folder = null;
  const where = $(".sk-where");
  where.value = where.children.at(-1).getAttribute("value");
  where.fire("change");
  await flush();
  await flush();
  assert.deepEqual(State.settings.skillFolders, []);
  assert.deepEqual(sent("save_settings"), []);
  assert.equal(where.value, "");
});
