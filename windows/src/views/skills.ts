// Skills view — the island's fifth tab: Claude Code's skills, the user's own
// and each project's, managed where the work is (src-tauri/src/skills.rs and
// skill_store.rs).
//
// "Installed" lists what is there: a switch turns a skill on or off, a button
// copies it to the folder chosen at the top (a project, or the user's own
// skills), another sends it to the bin after a second click. "Find" searches
// skills.sh — by a word typed, or a field picked from the chips — and adds a
// result to that same folder with one click. Only skills of the publishers
// skill_store.rs lists as verified show, until the box is unticked.
//
// "Suggest" hands the choice to Claude Code (skill_advisor.rs): the user says
// what they are working on, and gets a plan for the folder chosen at the top —
// skills to add, installed ones to remove, each with its reason. Nothing
// changes until the lines left ticked are applied; removed skills go to the bin.
// A request that says so ("my global skills too") may bring lines about
// another folder: each of those says which.
//
// The folder at the top is the user's own skills, a project Claude Code has
// worked in, or any folder picked with "Choose a folder…" (kept in the
// settings, skillFolders).

import { Bridge, onEvent, type FoundSkill, type SkillAdvice, type SkillGroup, type SkillInfo } from "../core/bridge";
import { State } from "../core/state";
import { featureOn } from "../core/features";
import { clear, h } from "./dom";
import { enhanceSelect } from "./select";
import type { ViewActions, ViewHost } from "./views";
import { N_, t, tl } from "../i18n/i18n";

/** The value of the folder list's last line: not a folder, the way to pick one. */
const PICK_FOLDER = "::choose-a-folder::";
/** As many picked folders as skills.rs keeps (MAX_NAMED). */
const MAX_FOLDERS = 20;

/** Search words for the fields people look for most. Words to search with, not labels: left as they are. */
const FIELDS = ["design", "frontend", "react", "testing", "docs", "deploy", "database", "mobile", "ai", "security"];

/** How far a plan is on its way, as skill_advisor.rs reports it. */
const ADVICE_STEPS: Record<string, string> = {
  reading: N_("Reading the project…"),
  searching: N_("Searching skills.sh…"),
  choosing: N_("Claude Code is choosing…"),
};

function errorText(err: unknown): string {
  return String(err).replace(/^Error:\s*/, "");
}

/** The last part of a path, whichever way its separators lean. */
function folderName(path: string): string {
  return path.split(/[\\/]/).filter((part) => part).pop() ?? path;
}

const compact = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

export function buildSkills(actions: ViewActions): ViewHost {
  let tab: "mine" | "find" | "plan" = "mine";
  let groups: SkillGroup[] = [];
  let projects: string[] = [];
  /** Where a skill is added or copied to: "" is the user's own skills, else a project's folder. */
  let dest = "";
  let found: FoundSkill[] = [];
  let searching = false;
  let verifiedOnly = true;
  /** Found skills added in this run, by `source/skillId`: their button says so. */
  const added = new Set<string>();
  let searchTimer: number | null = null;
  let asked = 0;
  /** The plan Claude Code proposed, and the folder it is for. */
  let advice: SkillAdvice | null = null;
  let adviceFor = "";
  let advising = false;
  let adviceStep = "reading";
  let advised = 0;
  let applying = false;
  /** The plan's lines left unticked, and what became of those applied ("" done, else why not). */
  const skipped = new Set<string>();
  const outcome = new Map<string, string>();
  /** The list was just filled anew (another tab, a search, a plan): its rows come in. */
  let fresh = true;

  const tabInstalled = h("button", { text: tl("Installed"), onclick: () => show("mine") });
  const tabFind = h("button", { text: tl("Find"), onclick: () => show("find") });
  const tabPlan = h("button", { text: tl("Suggest"), onclick: () => show("plan") });
  const ask = h("button", { class: "sk-btn primary sk-ask", text: tl("Ask Claude Code"), onclick: () => void runAdvice() }) as HTMLButtonElement;
  const apply = h("button", { class: "sk-btn primary sk-apply", onclick: () => void applyPlan() }) as HTMLButtonElement;
  const search = h("input", { type: "text", class: "sk-search", placeholder: tl("Search skills…") }) as HTMLInputElement;
  const where = h("select", { class: "sk-where", title: tl("Open folder") }) as HTMLSelectElement;
  const count = h("span", { class: "sk-count" });
  const chips = h("div", { class: "sk-chips" });
  const verifiedBox = h("button", { class: "sk-check on", text: tl("Verified only") });
  const note = h("div", { class: "sk-note" });
  const list = h("div", { class: "sk-list" });
  const el: HTMLElement = h(
    "div",
    { class: "view skills" },
    h(
      "div",
      { class: "card" },
      h("div", { class: "sk-top" }, h("div", { class: "seg sk-seg" }, tabInstalled, tabFind, tabPlan), search,
        // Drawn by the page, its list inside this card: the island's window takes the mouse nowhere else.
        enhanceSelect(where, "sk-where-box", () => el.firstElementChild as HTMLElement | null)),
      h("div", { class: "sk-bar" }, chips, count, verifiedBox, ask, apply),
      note,
      list,
    ),
  );

  for (const field of FIELDS) {
    chips.append(h("button", {
      class: "sk-chip",
      text: field,
      onclick: () => {
        actions.blip();
        search.value = field;
        if (tab !== "find") show("find");
        else runSearch();
      },
    }));
  }

  const say = (text: string, bad = false) => {
    note.textContent = text;
    note.classList.toggle("err", bad);
    note.style.display = text ? "" : "none";
  };

  // ── Data ────────────────────────────────────────────────────────────────────

  async function load() {
    const [listed, known] = await Promise.all([Bridge.skillsList(), Bridge.skillsProjects()]);
    groups = listed ?? [];
    projects = known ?? [];
    if (dest && !projects.includes(dest)) dest = "";
    fresh = true;
    drawWhere();
    draw();
  }

  function drawWhere() {
    clear(where);
    where.append(h("option", { value: "", text: t("My skills") }));
    for (const project of projects) where.append(h("option", { value: project, text: folderName(project), title: project }));
    where.append(h("option", { value: PICK_FOLDER, text: t("Choose a folder…") }));
    where.value = dest;
  }

  /** Lets the user pick any folder as a project, and remembers it. */
  async function pickFolder() {
    const picked = await Bridge.skillsPickFolder();
    if (picked && !State.settings.skillFolders.includes(picked)) {
      State.settings = { ...State.settings, skillFolders: [picked, ...State.settings.skillFolders].slice(0, MAX_FOLDERS) };
      await Bridge.saveSettings(State.settings);
    }
    if (picked) setDest(picked);
    await load();
  }

  function setDest(folder: string) {
    dest = folder;
    // A plan is for one folder: another folder, another plan.
    if (advice && adviceFor !== dest && !applying) {
      advice = null;
      skipped.clear();
      outcome.clear();
    }
  }

  function runSearch() {
    const query = search.value.trim();
    if (searchTimer != null) window.clearTimeout(searchTimer);
    searchTimer = null;
    if (query.length < 2) {
      found = [];
      searching = false;
      draw();
      return;
    }
    const mine = ++asked;
    searching = true;
    draw();
    void Bridge.skillsSearch(query, verifiedOnly)
      .then((skills) => {
        if (mine !== asked) return;
        found = skills ?? [];
        fresh = true;
        say("");
      })
      .catch((err) => {
        if (mine !== asked) return;
        found = [];
        say(errorText(err), true);
      })
      .finally(() => {
        if (mine !== asked) return;
        searching = false;
        draw();
      });
  }

  // ── The plan ────────────────────────────────────────────────────────────────

  /** Asks Claude Code for a plan for the folder at the top. Changes nothing. */
  async function runAdvice() {
    const request = search.value.trim();
    if (request.length < 2 || advising || applying) return;
    const mine = ++advised;
    const folder = dest;
    advising = true;
    adviceStep = "reading";
    advice = null;
    skipped.clear();
    outcome.clear();
    say("");
    draw();
    try {
      const plan = await Bridge.skillsAdvise(request, folder, verifiedOnly);
      if (mine !== advised) return;
      advice = plan;
      adviceFor = folder;
      fresh = true;
    } catch (err) {
      if (mine === advised) say(errorText(err), true);
    } finally {
      if (mine === advised) {
        advising = false;
        draw();
      }
    }
  }

  const addKey = (skill: { source: string; skillId: string; dest: string }) => `add:${skill.dest}|${skill.source}/${skill.skillId}`;
  /** A line about another folder than the plan's own says which. */
  const elsewhere = (folder: string): HTMLElement | null =>
    folder === adviceFor ? null : h("span", { class: "sk-tag where", text: folder ? folderName(folder) : t("My skills"), title: folder });
  const removeKey = (skill: { path: string }) => `remove:${skill.path}`;

  /**
   * Does what the plan's ticked lines say. Skills are added first, and nothing
   * is removed unless every one of them went in: a skill is only taken away
   * once what was to replace it is there.
   */
  async function applyPlan() {
    const plan = advice;
    if (!plan || applying || advising) return;
    applying = true;
    say("");
    draw();
    let added = 0;
    let removed = 0;
    let failed = false;
    for (const skill of plan.add) {
      const key = addKey(skill);
      if (skipped.has(key) || outcome.has(key)) continue;
      try {
        await Bridge.skillInstall(skill.source, skill.skillId, skill.dest);
        outcome.set(key, "");
        added++;
      } catch (err) {
        outcome.set(key, errorText(err));
        failed = true;
      }
      draw();
    }
    if (!failed) {
      for (const skill of plan.remove) {
        const key = removeKey(skill);
        if (skipped.has(key) || outcome.has(key)) continue;
        try {
          await Bridge.skillRemove(skill.path);
          outcome.set(key, "");
          removed++;
        } catch (err) {
          outcome.set(key, errorText(err));
        }
        draw();
      }
    }
    applying = false;
    if (failed) say(t("A skill could not be added, so none was removed."), true);
    else say(t("Done: {added} added, {removed} removed.", { added, removed }));
    await load();
  }

  function planRow(kind: "add" | "remove", key: string, name: string, reason: string, more: (Node | null)[] = []): HTMLElement {
    const done = outcome.get(key);
    const ticked = !skipped.has(key);
    const tick = h("button", { class: ticked ? "sk-switch on" : "sk-switch" }) as HTMLButtonElement;
    tick.disabled = applying || done != null;
    tick.addEventListener("click", () => {
      if (skipped.has(key)) skipped.delete(key);
      else skipped.add(key);
      draw();
    });
    const label = kind === "add" ? (done === "" ? t("Added") : t("Add")) : done === "" ? t("Removed") : t("Remove");
    const title = h("div", { class: "sk-name" }, h("span", { text: name }), h("span", { class: kind === "add" ? "sk-tag ok" : "sk-tag bad", text: label }));
    for (const part of more) if (part) title.append(part);
    // Why, or — once tried and refused — why not.
    const why = h("div", { class: done ? "sk-desc err" : "sk-desc", text: done || reason, title: reason });
    return h(
      "div",
      { class: `sk-row sk-plan ${kind}${ticked ? "" : " off"}${done === "" ? " done" : ""}` },
      tick,
      h("div", { class: "sk-text" }, title, why),
    );
  }

  function drawPlan() {
    if (advising) {
      list.append(h("div", { class: "sk-empty sk-thinking", text: t(ADVICE_STEPS[adviceStep] ?? ADVICE_STEPS.reading) }));
      return;
    }
    if (!advice) {
      list.append(h("div", {
        class: "sk-empty sk-plan-help",
        text: t("Say what you are working on, then ask: Claude Code looks for skills that fit the folder chosen above, and for installed ones that are no use there or would get in the way. Nothing changes until you apply; removed skills go to the bin."),
      }));
      return;
    }
    if (advice.note) list.append(h("div", { class: "sk-plan-note", text: advice.note }));
    if (advice.add.length + advice.remove.length === 0) {
      list.append(h("div", { class: "sk-empty", text: t("Nothing to change: the skills here already fit.") }));
      return;
    }
    let open = 0;
    for (const skill of advice.add) {
      const key = addKey(skill);
      if (!skipped.has(key) && !outcome.has(key)) open++;
      const facts = h("span", { class: "sk-tag", text: `${skill.source} · ${t("{n} installs", { n: compact(skill.installs) })}` });
      list.append(planRow("add", key, skill.name, skill.reason, [
        elsewhere(skill.dest),
        skill.verified ? h("span", { class: "sk-tag ok", text: t("Verified") }) : null,
        facts,
      ]));
    }
    for (const skill of advice.remove) {
      const key = removeKey(skill);
      if (!skipped.has(key) && !outcome.has(key)) open++;
      list.append(planRow("remove", key, skill.name, skill.reason, [elsewhere(skill.dest)]));
    }
    apply.style.display = open > 0 || applying ? "" : "none";
    apply.disabled = applying || open === 0;
    apply.textContent = applying ? t("Applying…") : t("Apply {n}", { n: open });
  }

  void onEvent<string>("skills-advice-step", (step) => {
    if (!advising) return;
    adviceStep = step;
    draw();
  });

  // ── Rows ────────────────────────────────────────────────────────────────────

  /** A plugin's skill: shown with the plugin it comes from, turned on or off by Claude Code, not here. */
  function pluginRow(group: SkillGroup, skill: SkillInfo): HTMLElement {
    const plugin = group.plugin ?? "";
    return h(
      "div",
      { class: skill.enabled ? "sk-row" : "sk-row off", title: plugin },
      h("span", { class: skill.enabled ? "sk-switch on" : "sk-switch", style: "pointer-events:none;opacity:.6" }),
      h(
        "div",
        { class: "sk-text" },
        h("div", { class: "sk-name" },
          h("span", { text: skill.name }),
          h("span", { class: "sk-tag", text: plugin.split("@")[0] }),
          h("span", { class: "sk-tag", text: skill.enabled ? t("Plugin") : t("Plugin off") }),
        ),
        h("div", { class: "sk-desc", text: skill.description, title: skill.description }),
      ),
    );
  }

  /** A plugin whose skills could not be listed: said, not hidden. */
  function pluginProblemRow(group: SkillGroup): HTMLElement {
    return h(
      "div",
      { class: "sk-row off", title: group.root },
      h(
        "div",
        { class: "sk-text" },
        h("div", { class: "sk-name" }, h("span", { text: (group.plugin ?? "").split("@")[0] }), h("span", { class: "sk-tag", text: t("Plugin") })),
        h("div", { class: "sk-desc", text: t("Could not list its skills: {why}", { why: group.problem ?? "" }), title: group.root }),
      ),
    );
  }

  function installedRow(group: SkillGroup, skill: SkillInfo): HTMLElement {
    const toggle = h("button", { class: skill.enabled ? "sk-switch on" : "sk-switch" }) as HTMLButtonElement;
    toggle.addEventListener("click", async () => {
      toggle.disabled = true;
      try {
        await Bridge.skillSetEnabled(skill.path, !skill.enabled);
        skill.enabled = !skill.enabled;
        say("");
      } catch (err) {
        say(t("Could not write: {error}", { error: errorText(err) }), true);
      }
      draw();
    });

    const buttons = h("div", { class: "sk-actions" });
    // To the folder chosen at the top, when that is another one than its own.
    if (group.project !== dest) {
      buttons.append(h("button", {
        class: "sk-btn",
        text: dest ? t("Copy to project") : t("My skills"),
        title: dest || t("My skills"),
        onclick: async () => {
          try {
            await Bridge.skillCopy(skill.path, dest);
            say("");
            await load();
          } catch (err) {
            say(t("Could not add: {error}", { error: errorText(err) }), true);
          }
        },
      }));
    }
    const remove = h("button", { class: "sk-btn danger", text: t("Remove") }) as HTMLButtonElement;
    let armed = false;
    remove.addEventListener("click", async () => {
      // A first click asks; only a second one, soon after, removes.
      if (!armed) {
        armed = true;
        remove.textContent = t("Click again to remove");
        remove.classList.add("armed");
        window.setTimeout(() => {
          armed = false;
          remove.textContent = t("Remove");
          remove.classList.remove("armed");
        }, 3000);
        return;
      }
      try {
        await Bridge.skillRemove(skill.path);
        say("");
        await load();
      } catch (err) {
        say(t("Could not write: {error}", { error: errorText(err) }), true);
      }
    });
    buttons.append(remove);

    return h(
      "div",
      { class: skill.enabled ? "sk-row" : "sk-row off" },
      toggle,
      h(
        "div",
        { class: "sk-text" },
        h("div", { class: "sk-name" },
          h("span", { text: skill.name }),
          h("span", { class: "sk-tag", text: group.project ? folderName(group.project) : t("My skills") }),
        ),
        h("div", { class: "sk-desc", text: skill.description, title: skill.description }),
      ),
      buttons,
    );
  }

  function foundRow(skill: FoundSkill): HTMLElement {
    const id = `${skill.source}/${skill.skillId}`;
    const add = h("button", { class: "sk-btn primary", text: added.has(`${dest}|${id}`) ? t("Added") : t("Add") }) as HTMLButtonElement;
    add.disabled = added.has(`${dest}|${id}`);
    add.addEventListener("click", async () => {
      add.disabled = true;
      add.textContent = t("Adding…");
      try {
        await Bridge.skillInstall(skill.source, skill.skillId, dest);
        added.add(`${dest}|${id}`);
        add.textContent = t("Added");
        say("");
        void load();
      } catch (err) {
        add.disabled = false;
        add.textContent = t("Add");
        say(t("Could not add: {error}", { error: errorText(err) }), true);
      }
    });
    const name = h("div", { class: "sk-name" }, h("span", { text: skill.name }));
    if (skill.verified) name.append(h("span", { class: "sk-tag ok", text: t("Verified") }));
    return h(
      "div",
      { class: "sk-row" },
      h(
        "div",
        { class: "sk-text" },
        name,
        h("div", { class: "sk-desc", text: `${skill.source} · ${t("{n} installs", { n: compact(skill.installs) })}` }),
      ),
      h("div", { class: "sk-actions" },
        h("button", {
          class: "sk-btn",
          text: "↗",
          title: `skills.sh/${id}`,
          onclick: () => actions.openUrl(`https://skills.sh/${id}`),
        }),
        add,
      ),
    );
  }

  function draw() {
    // "Suggest" is a feature of its own (Settings → Features): off, the tab goes with its plan.
    const suggests = featureOn(State.settings, "skillAdvice");
    tabPlan.style.display = suggests ? "" : "none";
    if (!suggests && tab === "plan") {
      tab = "mine";
      say("");
    }
    tabInstalled.classList.toggle("on", tab === "mine");
    tabFind.classList.toggle("on", tab === "find");
    tabPlan.classList.toggle("on", tab === "plan");
    verifiedBox.classList.toggle("on", verifiedOnly);
    verifiedBox.style.display = tab === "mine" ? "none" : "";
    // "Suggest" takes a sentence, not a word to filter by, and has its own buttons.
    chips.style.display = tab === "plan" ? "none" : "";
    ask.style.display = tab === "plan" ? "" : "none";
    ask.disabled = advising || applying;
    apply.style.display = "none";
    search.placeholder = tab === "plan" ? t("What are you working on?") : t("Search skills…");
    clear(list);
    // Rows come in when the list is filled anew, not at every tick of a switch.
    list.classList.toggle("fresh", fresh);
    fresh = false;
    const query = search.value.trim().toLowerCase();

    if (tab === "plan") {
      count.textContent = "";
      drawPlan();
      return;
    }

    if (tab === "mine") {
      let total = 0;
      let on = 0;
      for (const group of groups) {
        if (group.problem && !query) list.append(pluginProblemRow(group));
        for (const skill of group.skills) {
          total++;
          if (skill.enabled) on++;
          if (query && !skill.name.toLowerCase().includes(query) && !skill.description.toLowerCase().includes(query)) continue;
          list.append(group.plugin ? pluginRow(group, skill) : installedRow(group, skill));
        }
      }
      count.textContent = t("{on} of {total} on", { on, total });
      if (!list.firstChild) list.append(h("div", { class: "sk-empty", text: t("No skills found.") }));
      return;
    }

    count.textContent = "";
    if (searching) {
      list.append(h("div", { class: "sk-empty", text: t("Loading…") }));
    } else if (query.length < 2) {
      list.append(h("div", { class: "sk-empty", text: t("Search for a skill, or pick a field.") }));
    } else if (found.length === 0) {
      list.append(h("div", { class: "sk-empty", text: t("No skills found.") }));
    } else {
      for (const skill of found) list.append(foundRow(skill));
    }
  }

  function show(next: "mine" | "find" | "plan") {
    actions.blip();
    tab = next;
    fresh = true;
    say("");
    if (tab === "find") runSearch();
    else draw();
  }

  // ── Input ───────────────────────────────────────────────────────────────────

  search.addEventListener("keydown", (e) => {
    if (tab === "plan" && (e as KeyboardEvent).key === "Enter") void runAdvice();
  });
  search.addEventListener("input", () => {
    // A request is sent when asked, not as it is typed.
    if (tab === "plan") return;
    if (tab === "mine") {
      draw();
      return;
    }
    // Asked once the typing pauses, not at every letter.
    if (searchTimer != null) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(runSearch, 350);
  });
  where.addEventListener("change", () => {
    if (where.value === PICK_FOLDER) {
      // Not a folder: the list goes back to where it was while one is picked.
      where.value = dest;
      void pickFolder();
      return;
    }
    setDest(where.value);
    fresh = true;
    draw();
  });
  verifiedBox.addEventListener("click", () => {
    verifiedOnly = !verifiedOnly;
    if (tab === "find") runSearch();
    else draw();
  });

  say("");
  draw();

  let wasShown = false;
  return {
    el,
    focus() {
      search.focus();
    },
    sync() {
      // Read again each time the tab comes up: skills change outside Coucou too.
      const shown = State.mode === "expanded" && State.view === "skills";
      if (shown && !wasShown) void load();
      wasShown = shown;
      // "Suggest" was turned on or off in Settings → Features: its tab follows.
      if ((tabPlan.style.display !== "none") !== featureOn(State.settings, "skillAdvice")) draw();
    },
  };
}
