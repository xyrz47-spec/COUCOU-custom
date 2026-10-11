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

import { Bridge, type FoundSkill, type SkillGroup, type SkillInfo } from "../core/bridge";
import { State } from "../core/state";
import { clear, h } from "./dom";
import { enhanceSelect } from "./select";
import type { ViewActions, ViewHost } from "./views";
import { t, tl } from "../i18n/i18n";

/** Search words for the fields people look for most. Words to search with, not labels: left as they are. */
const FIELDS = ["design", "frontend", "react", "testing", "docs", "deploy", "database", "mobile", "ai", "security"];

function errorText(err: unknown): string {
  return String(err).replace(/^Error:\s*/, "");
}

/** The last part of a path, whichever way its separators lean. */
function folderName(path: string): string {
  return path.split(/[\\/]/).filter((part) => part).pop() ?? path;
}

const compact = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

export function buildSkills(actions: ViewActions): ViewHost {
  let tab: "mine" | "find" = "mine";
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

  const tabInstalled = h("button", { text: tl("Installed"), onclick: () => show("mine") });
  const tabFind = h("button", { text: tl("Find"), onclick: () => show("find") });
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
      h("div", { class: "sk-top" }, h("div", { class: "seg sk-seg" }, tabInstalled, tabFind), search,
        // Drawn by the page, its list inside this card: the island's window takes the mouse nowhere else.
        enhanceSelect(where, "sk-where-box", () => el.firstElementChild as HTMLElement | null)),
      h("div", { class: "sk-bar" }, chips, count, verifiedBox),
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
    const [fresh, known] = await Promise.all([Bridge.skillsList(), Bridge.skillsProjects()]);
    groups = fresh ?? [];
    projects = known ?? [];
    if (dest && !projects.includes(dest)) dest = "";
    drawWhere();
    draw();
  }

  function drawWhere() {
    clear(where);
    where.append(h("option", { value: "", text: t("My skills") }));
    for (const project of projects) where.append(h("option", { value: project, text: folderName(project), title: project }));
    where.value = dest;
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

  // ── Rows ────────────────────────────────────────────────────────────────────

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
    tabInstalled.classList.toggle("on", tab === "mine");
    tabFind.classList.toggle("on", tab === "find");
    verifiedBox.classList.toggle("on", verifiedOnly);
    verifiedBox.style.display = tab === "find" ? "" : "none";
    clear(list);
    const query = search.value.trim().toLowerCase();

    if (tab === "mine") {
      let total = 0;
      let on = 0;
      for (const group of groups) {
        for (const skill of group.skills) {
          total++;
          if (skill.enabled) on++;
          if (query && !skill.name.toLowerCase().includes(query) && !skill.description.toLowerCase().includes(query)) continue;
          list.append(installedRow(group, skill));
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

  function show(next: "mine" | "find") {
    actions.blip();
    tab = next;
    say("");
    if (tab === "find") runSearch();
    else draw();
  }

  // ── Input ───────────────────────────────────────────────────────────────────

  search.addEventListener("input", () => {
    if (tab === "mine") {
      draw();
      return;
    }
    // Asked once the typing pauses, not at every letter.
    if (searchTimer != null) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(runSearch, 350);
  });
  where.addEventListener("change", () => {
    dest = where.value;
    draw();
  });
  verifiedBox.addEventListener("click", () => {
    verifiedOnly = !verifiedOnly;
    runSearch();
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
    },
  };
}
