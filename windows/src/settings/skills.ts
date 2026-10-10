// Settings → Skills: Claude Code's skills, the user's own and each project's,
// turned on and off (src-tauri/src/skills.rs). A skill that is off keeps its
// folder; only its SKILL.md is renamed, and renamed back when it is turned on.

import { Bridge, type SkillGroup, type SkillInfo } from "../core/bridge";
import { clear, h } from "../views/dom";
import { t } from "../i18n/i18n";

function errorText(err: unknown): string {
  return String(err).replace(/^Error:\s*/, "");
}

/** The last part of a path, whichever way its separators lean. */
function folderName(path: string): string {
  return path.split(/[\\/]/).filter((part) => part).pop() ?? path;
}

export function skillsSection(groups: SkillGroup[] | null): HTMLElement {
  const search = h("input", { type: "text", class: "skill-search", placeholder: t("Search skills…") }) as HTMLInputElement;
  const note = h("div", { class: "notice err", style: "display:none" });
  const list = h("div", { class: "skill-groups" });

  const failed = (err: unknown) => {
    note.textContent = t("Could not write: {error}", { error: errorText(err) });
    note.style.display = "";
  };

  const draw = () => {
    clear(list);
    const query = search.value.trim().toLowerCase();
    for (const group of groups ?? []) {
      const skills = group.skills.filter(
        (s) => !query || s.name.toLowerCase().includes(query) || s.description.toLowerCase().includes(query),
      );
      if (skills.length > 0) list.append(groupBlock(group, skills, () => (note.style.display = "none"), failed));
    }
    if (!list.firstChild) list.append(h("div", { class: "hint", text: t("No skills found.") }));
  };
  search.addEventListener("input", draw);
  draw();

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: t("Skills") })),
    h("div", {
      class: "hint",
      text: t("Turn Claude Code's skills on and off: your own, and each project's. A skill turned off stays in its folder with SKILL.md renamed to SKILL.md.disabled. New sessions pick the change up."),
    }),
    search,
    note,
    list,
  );
}

function groupBlock(
  group: SkillGroup,
  shown: SkillInfo[],
  changed: () => void,
  failed: (err: unknown) => void,
): HTMLElement {
  const count = h("span", { class: "hint" });
  const recount = () => {
    count.textContent = t("{on} of {total} on", {
      on: group.skills.filter((s) => s.enabled).length,
      total: group.skills.length,
    });
  };
  recount();

  const rows = h("div", { class: "skill-list" });
  for (const skill of shown) {
    rows.append(skillRow(skill, () => {
      recount();
      changed();
    }, failed));
  }

  const title = group.project ? `${t("Project skills")} · ${folderName(group.project)}` : t("My skills");
  return h(
    "div",
    { class: "skill-group" },
    h(
      "div",
      { class: "row" },
      h("span", { class: "subhead", text: title, title: group.root }),
      count,
      h("span", { class: "spacer" }),
      h("button", { text: t("Open folder"), onclick: () => void Bridge.skillReveal(group.root) }),
    ),
    rows,
  );
}

function skillRow(skill: SkillInfo, changed: () => void, failed: (err: unknown) => void): HTMLElement {
  const toggle = h("button", { class: "switch", "aria-pressed": skill.enabled }) as HTMLButtonElement;
  const row = h(
    "div",
    { class: "skill-row" },
    toggle,
    h(
      "div",
      { class: "skill-text" },
      h("div", { class: "skill-name", text: skill.name }),
      h("div", { class: "skill-desc", text: skill.description, title: skill.description }),
    ),
  );
  const paint = () => {
    toggle.classList.toggle("on", skill.enabled);
    toggle.setAttribute("aria-pressed", String(skill.enabled));
    row.classList.toggle("off", !skill.enabled);
  };
  paint();

  toggle.addEventListener("click", async () => {
    const next = !skill.enabled;
    toggle.disabled = true;
    try {
      await Bridge.skillSetEnabled(skill.path, next);
      skill.enabled = next;
      changed();
    } catch (err) {
      failed(err);
    } finally {
      toggle.disabled = false;
      paint();
    }
  });
  return row;
}
