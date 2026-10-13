// The "add" window's search of installed apps (src/settings/launcher.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
const { isApp, isPath, isWeb, matchingApps } = await import("../src/settings/launcher.ts");

const apps = [
  { name: "Calculator", target: "shell:AppsFolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App" },
  { name: "CurseForge", target: "shell:AppsFolder\\{6D809377-6AF0-444B-8957-A3773F02200E}\\CurseForge\\CurseForge.exe" },
  { name: "Minecraft Launcher", target: "shell:AppsFolder\\Microsoft.4297127D64EC6_8wekyb3d8bbwe!Minecraft" },
  { name: "Visual Studio Code", target: "shell:AppsFolder\\Microsoft.VisualStudioCode" },
  { name: "Xbox Game Bar", target: "shell:AppsFolder\\Microsoft.XboxGamingOverlay_8wekyb3d8bbwe!App" },
];
const names = (typed) => matchingApps(apps, typed).map((app) => app.name);

test("an installed app is a target of its own, beside addresses and paths", () => {
  for (const app of apps) assert.ok(isApp(app.target), app.target);
  assert.ok(isApp("SHELL:appsfolder\\Chrome"));
  for (const bad of ["shell:AppsFolder\\", "shell:AppsFolder", "shell:startup", 'shell:AppsFolder\\a" & calc', "shell:AppsFolder\\a\nb", "C:\\x.exe", "https://a.b"]) {
    assert.ok(!isApp(bad), bad);
  }
  assert.ok(!isPath(apps[0].target) && !isWeb(apps[0].target));
});

test("nothing typed lists every app, in the order given", () => {
  assert.deepEqual(names(""), apps.map((app) => app.name));
  assert.deepEqual(names("   "), apps.map((app) => app.name));
});

test("every word typed has to be in the name, whatever its case", () => {
  assert.deepEqual(names("code"), ["Visual Studio Code"]);
  assert.deepEqual(names("STUDIO vis"), ["Visual Studio Code"]);
  assert.deepEqual(names("game xbox"), ["Xbox Game Bar"]);
  assert.deepEqual(names("zzz"), []);
});

test("a name that starts with what was typed comes first", () => {
  // "c" is in every name but one; the two that start with it lead.
  assert.deepEqual(names("c"), ["Calculator", "CurseForge", "Minecraft Launcher", "Visual Studio Code"]);
  assert.deepEqual(names("la"), ["Calculator", "Minecraft Launcher"]);
});

// ── Settings → Launcher follows the "add" window ─────────────────────────────

test("an entry saved from the add window shows in Settings without reopening it", async () => {
  const { launcherSection } = await import("../src/settings/launcher.ts");
  const settings = { launcher: [{ name: "Docs", target: "https://docs.example.com" }] };
  let redraw = () => {};
  const section = launcherSection(() => settings, async () => {}, (fn) => { redraw = fn; });
  const rows = () => {
    const out = [];
    const walk = (node) => {
      if (node.className === "launch-list") out.push(...node.children);
      node.children?.forEach(walk);
    };
    walk(section);
    return out;
  };
  assert.equal(rows().length, 1);
  // The window swaps the settings for a fresh object when the add window saves.
  settings.launcher = [...settings.launcher, { name: "Notes", target: "https://notes.example.com" }];
  redraw();
  assert.equal(rows().length, 2);
});
