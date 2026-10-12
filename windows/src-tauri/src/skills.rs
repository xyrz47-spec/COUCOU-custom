// Claude Code's skills, for Settings → Skills: the user's own
// (~/.claude/skills) and those of each project Claude Code has worked in
// (<project>/.claude/skills), listed and turned on and off.
//
// A skill is a folder with a SKILL.md in it. Turning one off renames that file
// to SKILL.md.disabled, where Claude Code no longer finds it; turning it on
// renames it back. Nothing is deleted and nothing else in the folder is
// touched. Only folders this file listed itself can be changed: a path handed
// over by the page is checked against them first.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

use crate::platform;

const SKILL_FILE: &str = "SKILL.md";
const DISABLED_FILE: &str = "SKILL.md.disabled";
/// A session file says where it ran within its first few lines.
const SESSION_LINES: usize = 40;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub name: String,
    pub description: String,
    /// The skill's folder.
    pub path: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillGroup {
    /// The project's folder; empty for the user's own skills.
    pub project: String,
    /// The folder the skills are in.
    pub root: String,
    pub skills: Vec<Skill>,
    /// For the skills of an installed Claude Code plugin: its id
    /// (`name@marketplace`). Empty for a skills folder. A plugin's skills are
    /// read, never renamed: the plugin is Claude Code's to turn on and off.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub plugin: String,
    /// Whether Claude Code has the plugin turned on (only for a plugin).
    pub plugin_enabled: bool,
    /// Why a plugin's skills could not be listed; empty when they could.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub problem: String,
}

/// Project folders the user named themselves (settings.skill_folders), kept
/// here so the listing below needs no settings handed to it. Set at launch
/// and each time the settings are saved.
static NAMED: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());
/// As many named folders as are kept.
pub const MAX_NAMED: usize = 20;

/// The folders named in the settings: full paths only, each once.
pub fn set_named_folders(folders: &[String]) {
    let mut named: Vec<PathBuf> = Vec::new();
    for folder in folders {
        let path = PathBuf::from(folder.trim());
        if path.is_absolute() && !named.contains(&path) {
            named.push(path);
        }
        if named.len() == MAX_NAMED {
            break;
        }
    }
    *NAMED.lock().unwrap() = named;
}

pub(crate) fn user_root() -> PathBuf {
    platform::home_dir().join(".claude").join("skills")
}

/// Where the newest session of a `~/.claude/projects/<name>` folder ran. The
/// folder's own name is the path with its separators flattened, which cannot
/// be turned back into a path; the session files say it outright.
fn session_cwd(dir: &Path) -> Option<PathBuf> {
    let newest = fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .max_by_key(|p| fs::metadata(p).and_then(|m| m.modified()).ok())?;
    let file = fs::File::open(newest).ok()?;
    for line in BufReader::new(file).lines().take(SESSION_LINES).map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        if let Some(cwd) = value.get("cwd").and_then(|c| c.as_str()) {
            return Some(PathBuf::from(cwd));
        }
    }
    None
}

/// The folders Claude Code has worked in, and those the user named, that are
/// still there, sorted: the projects a skill can be added to (skill_store.rs).
pub(crate) fn project_dirs() -> Vec<PathBuf> {
    let mut projects: Vec<PathBuf> = Vec::new();
    if let Ok(entries) = fs::read_dir(platform::home_dir().join(".claude").join("projects")) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            if let Some(cwd) = session_cwd(&path) {
                if cwd.is_dir() && !projects.contains(&cwd) {
                    projects.push(cwd);
                }
            }
        }
    }
    for named in NAMED.lock().unwrap().iter() {
        if named.is_dir() && !projects.contains(named) {
            projects.push(named.clone());
        }
    }
    projects.sort();
    projects
}

/// Every folder skills are looked for in: the user's, then each project's that has one.
fn roots() -> Vec<(String, PathBuf)> {
    let user = user_root();
    let mut out = vec![(String::new(), user.clone())];
    for project in project_dirs() {
        let root = project.join(".claude").join("skills");
        if root.is_dir() && root != user {
            out.push((project.to_string_lossy().into_owned(), root));
        }
    }
    out
}

fn unquote(value: &str) -> String {
    let v = value.trim();
    let quoted = v.len() >= 2
        && ((v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\'')));
    if quoted { v[1..v.len() - 1].to_string() } else { v.to_string() }
}

/// `name` and `description` of a SKILL.md's front matter. A description may be
/// folded over the lines that follow it (`description: >`).
fn front_matter(text: &str) -> (Option<String>, String) {
    let mut lines = text.trim_start_matches('\u{feff}').lines();
    if lines.next().map(str::trim) != Some("---") {
        return (None, String::new());
    }
    let mut name = None;
    let mut description = String::new();
    let mut folding = false;
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        if folding {
            if line.starts_with(' ') || line.starts_with('\t') {
                if !description.is_empty() {
                    description.push(' ');
                }
                description.push_str(line.trim());
                continue;
            }
            folding = false;
        }
        if let Some(value) = line.strip_prefix("name:") {
            name = Some(unquote(value)).filter(|n| !n.is_empty());
        } else if let Some(value) = line.strip_prefix("description:") {
            let value = value.trim();
            if matches!(value, "" | ">" | "|" | ">-" | "|-" | ">+" | "|+") {
                folding = true;
                description.clear();
            } else {
                description = unquote(value);
            }
        }
    }
    (name, description)
}

pub(crate) fn read_skills(root: &Path) -> Vec<Skill> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(root) else { return out };
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let (file, enabled) = if dir.join(SKILL_FILE).is_file() {
            (dir.join(SKILL_FILE), true)
        } else if dir.join(DISABLED_FILE).is_file() {
            (dir.join(DISABLED_FILE), false)
        } else {
            continue;
        };
        let text = fs::read(&file).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
        let (name, description) = front_matter(&text);
        let folder = entry.file_name().to_string_lossy().into_owned();
        out.push(Skill {
            name: name.unwrap_or(folder),
            description,
            path: dir.to_string_lossy().into_owned(),
            enabled,
        });
    }
    out.sort_by_key(|s| s.name.to_lowercase());
    out
}

/// `dir` is a skill's folder, directly inside one of the folders listed.
pub(crate) fn known_skill(dir: &Path) -> bool {
    let Some(parent) = dir.parent().and_then(|p| p.canonicalize().ok()) else { return false };
    dir.is_dir() && roots().iter().any(|(_, root)| root.canonicalize().is_ok_and(|r| r == parent))
}

fn set_enabled(dir: &Path, enabled: bool) -> Result<(), String> {
    let (from, to) = if enabled {
        (dir.join(DISABLED_FILE), dir.join(SKILL_FILE))
    } else {
        (dir.join(SKILL_FILE), dir.join(DISABLED_FILE))
    };
    if to.exists() {
        // Already as asked, unless both files are there: that one is the user's to sort out.
        return if from.exists() { Err(format!("{} is already there", to.display())) } else { Ok(()) };
    }
    fs::rename(&from, &to).map_err(|e| e.to_string())
}

// ── Skills that come with plugins ─────────────────────────────────────────────
//
// `/plugin install name@marketplace` does not copy anything into a skills
// folder. Claude Code records the install in ~/.claude/plugins/installed_plugins.json
// (the plugin's id, where it was put, its scope), whether it is on in the
// `enabledPlugins` of a settings.json, and finds the plugin's skills in the
// `skills` folder of the install (or the folders its .claude-plugin/plugin.json
// names). These are listed read-only: turning a plugin on or off is a change to
// settings.json, which hooks.rs alone writes, after a diff and a backup.

/// A settings.json's `enabledPlugins`: `{"id": true}`, or a list of ids.
fn enabled_plugins(settings: &Path) -> std::collections::HashMap<String, bool> {
    let mut out = std::collections::HashMap::new();
    let Ok(text) = fs::read(settings) else { return out };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&text) else { return out };
    match value.get("enabledPlugins") {
        Some(serde_json::Value::Object(map)) => {
            for (id, on) in map {
                if let Some(on) = on.as_bool() {
                    out.insert(id.clone(), on);
                }
            }
        }
        Some(serde_json::Value::Array(ids)) => {
            for id in ids.iter().filter_map(|i| i.as_str()) {
                out.insert(id.to_string(), true);
            }
        }
        _ => {}
    }
    out
}

/// Folders a plugin keeps skills in: `skills/`, and those its manifest names
/// (relative paths that stay inside the plugin).
fn plugin_skill_roots(install: &Path) -> Vec<PathBuf> {
    let mut roots = vec![install.join("skills")];
    let manifest = install.join(".claude-plugin").join("plugin.json");
    if let Some(value) = fs::read(manifest).ok().and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok()) {
        let named: Vec<&str> = match value.get("skills") {
            Some(serde_json::Value::String(one)) => vec![one.as_str()],
            Some(serde_json::Value::Array(many)) => many.iter().filter_map(|m| m.as_str()).collect(),
            _ => Vec::new(),
        };
        for relative in named {
            let relative = relative.trim().trim_start_matches("./");
            let inside = !relative.is_empty()
                && Path::new(relative).components().all(|c| matches!(c, std::path::Component::Normal(_)));
            if inside {
                let path = install.join(relative);
                if !roots.contains(&path) {
                    roots.push(path);
                }
            }
        }
    }
    roots
}

/// The skills of one plugin install: the folders inside each skills folder,
/// or a folder that is itself a skill.
fn plugin_skills(install: &Path, enabled: bool) -> Vec<Skill> {
    let mut out: Vec<Skill> = Vec::new();
    for root in plugin_skill_roots(install) {
        let mut found = if root.join(SKILL_FILE).is_file() {
            let parent = root.parent().unwrap_or(&root);
            read_skills(parent).into_iter().filter(|s| Path::new(&s.path) == root).collect()
        } else {
            read_skills(&root)
        };
        out.append(&mut found);
    }
    out.sort_by_key(|s| s.name.to_lowercase());
    out.dedup_by(|b, a| a.path == b.path);
    for skill in &mut out {
        skill.enabled = enabled;
    }
    out
}

/// Every installed plugin that brings skills, or that could not be read, from
/// the Claude Code folder `claude_dir` (~/.claude).
fn plugin_groups(claude_dir: &Path) -> Vec<SkillGroup> {
    let registry = claude_dir.join("plugins").join("installed_plugins.json");
    let Ok(bytes) = fs::read(&registry) else { return Vec::new() };
    let failed = |why: String| SkillGroup {
        project: String::new(),
        root: registry.to_string_lossy().into_owned(),
        skills: Vec::new(),
        plugin: "installed_plugins.json".into(),
        plugin_enabled: false,
        problem: why,
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return vec![failed("not valid JSON".into())];
    };
    let Some(plugins) = value.get("plugins").and_then(|p| p.as_object()) else {
        return vec![failed("no plugins listed".into())];
    };
    let user_enabled = enabled_plugins(&claude_dir.join("settings.json"));

    let mut ids: Vec<&String> = plugins.keys().collect();
    ids.sort();
    let mut groups = Vec::new();
    for id in ids {
        // Version 2 of the file keeps a list of installs per plugin; version 1, one.
        let installs: Vec<&serde_json::Value> = match &plugins[id] {
            serde_json::Value::Array(many) => many.iter().collect(),
            one @ serde_json::Value::Object(_) => vec![one],
            _ => Vec::new(),
        };
        for install in installs {
            let text = |key: &str| install.get(key).and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
            let (path, project) = (text("installPath"), text("projectPath"));
            let mut enabled = user_enabled.clone();
            if !project.is_empty() {
                let project_claude = Path::new(&project).join(".claude");
                enabled.extend(enabled_plugins(&project_claude.join("settings.json")));
                enabled.extend(enabled_plugins(&project_claude.join("settings.local.json")));
            }
            let on = enabled.get(id).copied().unwrap_or(false);
            let dir = PathBuf::from(&path);
            let mut group = SkillGroup {
                project,
                root: path.clone(),
                skills: Vec::new(),
                plugin: id.clone(),
                plugin_enabled: on,
                problem: String::new(),
            };
            if path.is_empty() || !dir.is_dir() {
                group.problem = "its folder is not there".into();
            } else {
                group.skills = plugin_skills(&dir, on);
            }
            // A plugin with no skill (commands only, say) is not a skill list's business.
            if !group.skills.is_empty() || !group.problem.is_empty() {
                groups.push(group);
            }
        }
    }
    groups
}

/// The user's skills first, then each project's, then those of the installed
/// plugins; folders without a skill are left out.
#[tauri::command(async)]
pub fn skills_list(shared: tauri::State<crate::Shared>) -> Vec<SkillGroup> {
    // Settings → Features → "Skills of installed plugins", off: only the skills folders.
    let plugins = !shared.settings.lock().unwrap().disabled_features.iter().any(|f| f == "pluginSkills");
    let mut groups: Vec<SkillGroup> = roots()
        .into_iter()
        .map(|(project, root)| SkillGroup {
            project,
            skills: read_skills(&root),
            root: root.to_string_lossy().into_owned(),
            plugin: String::new(),
            plugin_enabled: false,
            problem: String::new(),
        })
        .filter(|group| !group.skills.is_empty())
        .collect();
    if plugins {
        groups.extend(plugin_groups(&platform::home_dir().join(".claude")));
    }
    groups
}

#[tauri::command(async)]
pub fn skill_set_enabled(path: String, enabled: bool) -> Result<(), String> {
    let dir = PathBuf::from(&path);
    if !known_skill(&dir) {
        return Err(format!("{path} is not a skill folder Coucou listed"));
    }
    set_enabled(&dir, enabled)?;
    crate::log::line(format!("skill {} {}", if enabled { "on" } else { "off" }, dir.display()));
    Ok(())
}

/// Opens a skills folder, or one skill's, in the file manager.
#[tauri::command]
pub fn skill_reveal(path: String) {
    let dir = PathBuf::from(&path);
    let listed = known_skill(&dir)
        || dir.canonicalize().is_ok_and(|d| roots().iter().any(|(_, r)| r.canonicalize().is_ok_and(|r| r == d)));
    if listed {
        platform::reveal_folder(&path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("coucou-skills-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn front_matter_reads_name_and_description() {
        let (name, description) = front_matter("---\nname: animate\ndescription: \"Animation patterns.\"\nversion: 1\n---\n# Body\n");
        assert_eq!(name.as_deref(), Some("animate"));
        assert_eq!(description, "Animation patterns.");
    }

    #[test]
    fn a_folded_description_is_joined_and_no_front_matter_is_nothing() {
        let (name, description) = front_matter("\u{feff}---\ndescription: >\n  First line\n  second line\nname: x\n---\n");
        assert_eq!(name.as_deref(), Some("x"));
        assert_eq!(description, "First line second line");
        assert_eq!(front_matter("# Just a title\nname: no\n"), (None, String::new()));
    }

    #[test]
    fn skills_are_listed_by_name_with_their_state_and_other_folders_are_left_out() {
        let root = temp("list");
        for (folder, file, text) in [
            ("b-skill", SKILL_FILE, "---\nname: Beta\ndescription: second\n---\n"),
            ("a-skill", DISABLED_FILE, "---\ndescription: first\n---\n"),
            ("notes", "README.md", "not a skill"),
        ] {
            fs::create_dir_all(root.join(folder)).unwrap();
            fs::write(root.join(folder).join(file), text).unwrap();
        }
        let skills = read_skills(&root);
        let seen: Vec<_> = skills.iter().map(|s| (s.name.as_str(), s.description.as_str(), s.enabled)).collect();
        assert_eq!(seen, [("a-skill", "first", false), ("Beta", "second", true)]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn turning_a_skill_off_and_on_only_renames_its_file() {
        let root = temp("toggle");
        let dir = root.join("one");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(SKILL_FILE), "---\nname: one\n---\nbody").unwrap();
        fs::write(dir.join("helper.py"), "print(1)").unwrap();

        set_enabled(&dir, false).unwrap();
        assert!(!dir.join(SKILL_FILE).exists());
        assert_eq!(fs::read_to_string(dir.join(DISABLED_FILE)).unwrap(), "---\nname: one\n---\nbody");
        // Asked again: nothing to do, nothing lost.
        set_enabled(&dir, false).unwrap();

        set_enabled(&dir, true).unwrap();
        assert_eq!(fs::read_to_string(dir.join(SKILL_FILE)).unwrap(), "---\nname: one\n---\nbody");
        assert!(!dir.join(DISABLED_FILE).exists());
        assert!(dir.join("helper.py").exists());

        // Both files there: neither is written over.
        fs::write(dir.join(DISABLED_FILE), "other").unwrap();
        assert!(set_enabled(&dir, false).is_err());
        assert_eq!(fs::read_to_string(dir.join(DISABLED_FILE)).unwrap(), "other");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_folder_the_user_named_is_a_project_like_any_other() {
        let project = temp("named");
        let dir = project.join(".claude").join("skills").join("one");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(SKILL_FILE), "---\nname: one\n---\n").unwrap();
        assert!(!project_dirs().contains(&project));
        assert!(!known_skill(&dir));

        set_named_folders(&["relative/path".into(), project.to_string_lossy().into_owned(), project.to_string_lossy().into_owned()]);
        assert_eq!(NAMED.lock().unwrap().len(), 1);
        assert!(project_dirs().contains(&project));
        assert!(known_skill(&dir));
        // A named folder that is gone is not offered.
        set_named_folders(&[project.join("gone").to_string_lossy().into_owned()]);
        assert!(!project_dirs().contains(&project.join("gone")));
        let many: Vec<String> = (0..50).map(|i| project.join(format!("p{i}")).to_string_lossy().into_owned()).collect();
        set_named_folders(&many);
        assert_eq!(NAMED.lock().unwrap().len(), MAX_NAMED);
        set_named_folders(&[]);
        let _ = fs::remove_dir_all(&project);
    }

    #[test]
    fn a_plugins_skills_are_found_where_claude_code_put_them() {
        let home = temp("plugins");
        let install = home.join("plugins").join("cache").join("mk").join("superpowers").join("5.0.0");
        let skill = install.join("skills").join("brainstorming");
        fs::create_dir_all(&skill).unwrap();
        fs::write(skill.join(SKILL_FILE), "---\nname: brainstorming\ndescription: Think first.\n---\n").unwrap();
        // A folder the manifest names, and one that tries to leave the plugin.
        let extra = install.join("extra").join("one");
        fs::create_dir_all(&extra).unwrap();
        fs::write(extra.join(SKILL_FILE), "---\nname: one\n---\n").unwrap();
        fs::create_dir_all(install.join(".claude-plugin")).unwrap();
        fs::write(install.join(".claude-plugin").join("plugin.json"), r#"{"skills":["./extra","../outside"]}"#).unwrap();
        let gone = home.join("nowhere");
        let registry = serde_json::json!({
            "version": 2,
            "plugins": {
                "superpowers@claude-plugins-official": [{"scope": "user", "installPath": install, "version": "5.0.0"}],
                "ghost@mk": [{"scope": "user", "installPath": gone}],
                "commands-only@mk": [{"scope": "user", "installPath": home}],
            }
        });
        fs::write(home.join("plugins").join("installed_plugins.json"), registry.to_string()).unwrap();

        // Not in enabledPlugins: listed, shown as off.
        let groups = plugin_groups(&home);
        let sp = groups.iter().find(|g| g.plugin == "superpowers@claude-plugins-official").unwrap();
        let names: Vec<_> = sp.skills.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["brainstorming", "one"]);
        assert!(!sp.plugin_enabled && sp.skills.iter().all(|s| !s.enabled));
        assert_eq!(sp.skills[0].description, "Think first.");

        fs::write(home.join("settings.json"), r#"{"enabledPlugins":{"superpowers@claude-plugins-official":true}}"#).unwrap();
        let sp = plugin_groups(&home).into_iter().find(|g| g.plugin.starts_with("superpowers")).unwrap();
        assert!(sp.plugin_enabled && sp.skills.iter().all(|s| s.enabled));

        // A missing folder is said, a plugin without skills is left out.
        let groups = plugin_groups(&home);
        assert!(groups.iter().find(|g| g.plugin == "ghost@mk").is_some_and(|g| !g.problem.is_empty()));
        assert!(!groups.iter().any(|g| g.plugin == "commands-only@mk"));
        // Nothing the page could rename: a plugin's skill is no listed skills folder.
        assert!(!known_skill(&skill));
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn a_project_plugin_is_on_by_its_projects_settings_and_the_old_registry_form_is_read() {
        let home = temp("plugins-project");
        let project = temp("plugins-project-dir");
        let install = home.join("p");
        fs::create_dir_all(install.join("skills").join("s")).unwrap();
        fs::write(install.join("skills").join("s").join(SKILL_FILE), "---\nname: s\n---\n").unwrap();
        fs::create_dir_all(project.join(".claude")).unwrap();
        fs::write(project.join(".claude").join("settings.json"), r#"{"enabledPlugins":{"p@mk":true}}"#).unwrap();
        fs::write(project.join(".claude").join("settings.local.json"), r#"{"enabledPlugins":{"p@mk":false}}"#).unwrap();
        fs::create_dir_all(home.join("plugins")).unwrap();
        // Version 1: one install per plugin, an object.
        let registry = serde_json::json!({"version": 1, "plugins": {"p@mk": {"installPath": install, "projectPath": project}}});
        fs::write(home.join("plugins").join("installed_plugins.json"), registry.to_string()).unwrap();
        let group = plugin_groups(&home).pop().unwrap();
        assert_eq!(group.project, project.to_string_lossy());
        assert!(!group.plugin_enabled, "the local settings win over the project's");

        fs::write(home.join("plugins").join("installed_plugins.json"), "{oops").unwrap();
        assert!(!plugin_groups(&home)[0].problem.is_empty());
        let _ = fs::remove_dir_all(&home);
        let _ = fs::remove_dir_all(&project);
    }

    #[test]
    fn a_folder_that_was_not_listed_is_refused() {
        let root = temp("refuse");
        let dir = root.join("stray");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(SKILL_FILE), "---\nname: stray\n---\n").unwrap();
        assert!(!known_skill(&dir));
        assert!(skill_set_enabled(dir.to_string_lossy().into_owned(), false).is_err());
        assert!(dir.join(SKILL_FILE).exists());
        let _ = fs::remove_dir_all(&root);
    }
}
