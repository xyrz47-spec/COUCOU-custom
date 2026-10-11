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

/// The user's skills first, then each project's; folders without a skill are left out.
#[tauri::command(async)]
pub fn skills_list() -> Vec<SkillGroup> {
    roots()
        .into_iter()
        .map(|(project, root)| SkillGroup {
            project,
            skills: read_skills(&root),
            root: root.to_string_lossy().into_owned(),
        })
        .filter(|group| !group.skills.is_empty())
        .collect()
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
