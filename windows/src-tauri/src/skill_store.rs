// Finding, adding, copying and removing Claude Code skills, for the island's
// Skills tab (src/views/skills.ts). Listing them and turning them on and off
// is skills.rs.
//
// Skills are found through skills.sh, the directory of the open skills
// ecosystem (the one `npx skills find` asks). A found skill lives in a GitHub
// repository: adding it downloads that skill's folder, and only that folder,
// into the user's skills or a project's. Nothing in it is run by Coucou.
//
// A skill is instructions Claude Code will follow, so where it comes from
// matters. skills.sh says nothing about that itself, so "verified" here means
// one thing only: the repository belongs to one of the publishers listed in
// VERIFIED_OWNERS, companies that publish skills for their own products. The
// tab shows only those until the user asks for the rest.
//
// Removing a skill sends its folder to the system's bin, where it can be
// taken back from. Only folders skills.rs listed itself can be removed or
// copied, and only into the user's skills or a project Claude Code worked in.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::{platform, skills};

const SEARCH_URL: &str = "https://skills.sh/api/search";
const SEARCH_LIMIT: &str = "60";
const TIMEOUT: Duration = Duration::from_secs(20);
/// Publishers whose skills are shown as verified: see the top of this file.
const VERIFIED_OWNERS: &[&str] = &[
    "anthropics", "vercel-labs", "vercel", "microsoft", "github", "google", "googleworkspace", "supabase",
    "stripe", "cloudflare", "expo", "remotion-dev", "shadcn-ui", "openai", "huggingface",
];
/// A skill is a few files of text and scripts: anything far past that is refused.
const MAX_FILES: usize = 300;
const MAX_FILE: usize = 5 * 1024 * 1024;
const MAX_TOTAL: usize = 25 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundSkill {
    /// `owner/repo` on GitHub.
    pub source: String,
    /// The skill's folder name in that repository, and here once added.
    pub skill_id: String,
    pub name: String,
    pub installs: u64,
    pub verified: bool,
}

/// A name that is safe as one path segment and one URL segment.
fn is_slug(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 100
        && text != "."
        && text != ".."
        && text.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn is_source(text: &str) -> bool {
    matches!(text.split_once('/'), Some((owner, repo)) if is_slug(owner) && is_slug(repo))
}

pub fn is_verified(source: &str) -> bool {
    let owner = source.split('/').next().unwrap_or("").to_ascii_lowercase();
    VERIFIED_OWNERS.contains(&owner.as_str())
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        .user_agent(concat!("Coucou/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())
}

/// What skills.sh answered, as the tab shows it: verified publishers first,
/// then the most installed.
pub fn found_skills(answer: &Value, verified_only: bool) -> Vec<FoundSkill> {
    let mut out: Vec<FoundSkill> = answer
        .get("skills")
        .and_then(Value::as_array)
        .map(|list| list.as_slice())
        .unwrap_or_default()
        .iter()
        .filter_map(|entry| {
            let source = entry.get("source")?.as_str()?;
            let skill_id = entry.get("skillId")?.as_str()?;
            if !is_source(source) || !is_slug(skill_id) {
                return None;
            }
            Some(FoundSkill {
                source: source.to_string(),
                skill_id: skill_id.to_string(),
                name: entry.get("name").and_then(Value::as_str).unwrap_or(skill_id).to_string(),
                installs: entry.get("installs").and_then(Value::as_u64).unwrap_or(0),
                verified: is_verified(source),
            })
        })
        .filter(|skill| skill.verified || !verified_only)
        .collect();
    out.sort_by(|a, b| b.verified.cmp(&a.verified).then(b.installs.cmp(&a.installs)));
    out
}

/// Skills matching `query`, from skills.sh.
#[tauri::command]
pub async fn skills_search(query: String, verified_only: bool) -> Result<Vec<FoundSkill>, String> {
    let query = query.trim();
    if query.chars().count() < 2 || query.len() > 80 {
        return Ok(Vec::new());
    }
    let url = reqwest::Url::parse_with_params(SEARCH_URL, [("q", query), ("limit", SEARCH_LIMIT)])
        .map_err(|e| e.to_string())?;
    let response = client()?.get(url).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("skills.sh answered {}", response.status()));
    }
    let body = crate::net::read_capped(response, 2 * 1024 * 1024).await?;
    let answer: Value = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
    Ok(found_skills(&answer, verified_only))
}

/// The folders a skill can be added to besides the user's own: the projects
/// Claude Code has worked in.
#[tauri::command(async)]
pub fn skills_projects() -> Vec<String> {
    skills::project_dirs().into_iter().map(|p| p.to_string_lossy().into_owned()).collect()
}

/// The skills folder `dest` names: the user's for "", else that project's —
/// which has to be one Claude Code worked in.
fn dest_root(dest: &str) -> Result<PathBuf, String> {
    if dest.trim().is_empty() {
        return Ok(skills::user_root());
    }
    let wanted = Path::new(dest.trim());
    skills::project_dirs()
        .into_iter()
        .find(|p| p == wanted)
        .map(|p| p.join(".claude").join("skills"))
        .ok_or_else(|| format!("{dest} is not a project Coucou knows"))
}

/// The folder of skill `skill_id` among a repository's file paths: the one
/// named like it that holds a SKILL.md (the shallowest, if several); a
/// repository that is one skill is its own folder (""). `None`: not found.
pub fn skill_dir(paths: &[String], skill_id: &str) -> Option<String> {
    let dirs: Vec<&str> = paths
        .iter()
        .filter_map(|p| p.strip_suffix("SKILL.md"))
        .filter(|dir| dir.is_empty() || dir.ends_with('/'))
        .map(|dir| dir.trim_end_matches('/'))
        .collect();
    let named = dirs
        .iter()
        .filter(|dir| dir.rsplit('/').next() == Some(skill_id))
        .min_by_key(|dir| dir.matches('/').count());
    match named {
        Some(dir) => Some(dir.to_string()),
        None if dirs.len() == 1 => Some(dirs[0].to_string()),
        None => None,
    }
}

/// A file's path below the skill's folder, as it will be written: every part
/// an ordinary name, nothing that climbs out or names a drive.
fn safe_relative(path: &str) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for part in path.split('/') {
        if part.is_empty() || part == "." || part == ".." || part.contains(['\\', ':']) {
            return None;
        }
        out.push(part);
    }
    (!out.as_os_str().is_empty()).then_some(out)
}

/// Adds skill `skill_id` of `source` (owner/repo) to the user's skills
/// (`dest` "") or to a project's. Returns the folder it now is in.
#[tauri::command]
pub async fn skill_install(source: String, skill_id: String, dest: String) -> Result<String, String> {
    if !is_source(&source) || !is_slug(&skill_id) {
        return Err("That is not a skill Coucou can add.".into());
    }
    let root = dest_root(&dest)?;
    let target = root.join(&skill_id);
    if target.exists() {
        return Err(format!("{} is already there", target.display()));
    }

    let client = client()?;
    let tree_url = format!("https://api.github.com/repos/{source}/git/trees/HEAD?recursive=1");
    let response = client
        .get(tree_url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("GitHub answered {} for {source}", response.status()));
    }
    let body = crate::net::read_capped(response, 8 * 1024 * 1024).await?;
    let tree: Value = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
    let blobs: Vec<(String, u64)> = tree
        .get("tree")
        .and_then(Value::as_array)
        .map(|list| list.as_slice())
        .unwrap_or_default()
        .iter()
        .filter(|entry| entry.get("type").and_then(Value::as_str) == Some("blob"))
        .filter_map(|entry| {
            Some((entry.get("path")?.as_str()?.to_string(), entry.get("size").and_then(Value::as_u64).unwrap_or(0)))
        })
        .collect();
    let paths: Vec<String> = blobs.iter().map(|(p, _)| p.clone()).collect();
    let dir = skill_dir(&paths, &skill_id).ok_or_else(|| format!("{skill_id} was not found in {source}"))?;
    let prefix = if dir.is_empty() { String::new() } else { format!("{dir}/") };
    let files: Vec<&(String, u64)> = blobs.iter().filter(|(p, _)| p.starts_with(&prefix)).collect();
    let total: u64 = files.iter().map(|(_, size)| *size).sum();
    if files.is_empty() || files.len() > MAX_FILES || total as usize > MAX_TOTAL {
        return Err(format!("{skill_id} is not the size of a skill ({} files)", files.len()));
    }

    // Written beside its place, and moved there only once it is whole.
    let staging = root.join(format!(".{skill_id}.adding"));
    let _ = std::fs::remove_dir_all(&staging);
    let written = async {
        for (path, _) in &files {
            let relative = safe_relative(&path[prefix.len()..]).ok_or_else(|| format!("{path} is not a path Coucou will write"))?;
            let mut url = reqwest::Url::parse(&format!("https://raw.githubusercontent.com/{source}/HEAD/"))
                .map_err(|e| e.to_string())?;
            url.path_segments_mut().map_err(|_| "bad address".to_string())?.pop_if_empty().extend(path.split('/'));
            let response = client.get(url).send().await.map_err(|e| e.to_string())?;
            if !response.status().is_success() {
                return Err(format!("GitHub answered {} for {path}", response.status()));
            }
            let bytes = crate::net::read_capped(response, MAX_FILE).await?;
            let file = staging.join(relative);
            if let Some(parent) = file.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(&file, bytes).map_err(|e| e.to_string())?;
        }
        if !staging.join("SKILL.md").is_file() {
            return Err(format!("{skill_id} has no SKILL.md"));
        }
        std::fs::rename(&staging, &target).map_err(|e| e.to_string())
    }
    .await;
    if let Err(err) = written {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(err);
    }
    crate::log::line(format!("skill added: {source}/{skill_id} -> {}", target.display()));
    Ok(target.to_string_lossy().into_owned())
}

fn copy_dir(from: &Path, to: &Path, budget: &mut (usize, u64)) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(from).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        let dest = to.join(entry.file_name());
        if path.is_dir() {
            copy_dir(&path, &dest, budget)?;
        } else {
            budget.0 += 1;
            budget.1 += entry.metadata().map(|m| m.len()).unwrap_or(0);
            if budget.0 > MAX_FILES * 4 || budget.1 > (MAX_TOTAL * 4) as u64 {
                return Err("That folder is too large to be a skill.".into());
            }
            std::fs::copy(&path, &dest).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Copies an installed skill into a project's skills (`dest`, a project
/// folder) or the user's (""). Returns the copy's folder.
#[tauri::command(async)]
pub fn skill_copy(path: String, dest: String) -> Result<String, String> {
    let from = PathBuf::from(&path);
    if !skills::known_skill(&from) {
        return Err(format!("{path} is not a skill folder Coucou listed"));
    }
    let name = from.file_name().ok_or("No folder name.")?;
    let target = dest_root(&dest)?.join(name);
    if target.exists() {
        return Err(format!("{} is already there", target.display()));
    }
    if let Err(err) = copy_dir(&from, &target, &mut (0, 0)) {
        let _ = std::fs::remove_dir_all(&target);
        return Err(err);
    }
    crate::log::line(format!("skill copied: {} -> {}", from.display(), target.display()));
    Ok(target.to_string_lossy().into_owned())
}

/// Sends an installed skill's folder to the system's bin.
#[tauri::command(async)]
pub fn skill_remove(path: String) -> Result<(), String> {
    let dir = PathBuf::from(&path);
    if !skills::known_skill(&dir) {
        return Err(format!("{path} is not a skill folder Coucou listed"));
    }
    if !platform::move_to_bin(&dir) {
        return Err(format!("{path} could not be moved to the bin"));
    }
    crate::log::line(format!("skill removed (to the bin): {}", dir.display()));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn paths(list: &[&str]) -> Vec<String> {
        list.iter().map(|p| p.to_string()).collect()
    }

    #[test]
    fn only_plain_names_are_taken_as_a_skill_or_a_repository() {
        assert!(is_slug("frontend-design") && is_slug("a_b.c"));
        for bad in ["", ".", "..", "a/b", "a b", "a\\b", "c:", "é"] {
            assert!(!is_slug(bad), "{bad}");
        }
        assert!(is_source("anthropics/skills"));
        for bad in ["anthropics", "a/b/c", "/skills", "a/..", "../a"] {
            assert!(!is_source(bad), "{bad}");
        }
    }

    #[test]
    fn verified_is_a_publisher_from_the_list_whatever_its_case() {
        assert!(is_verified("anthropics/skills"));
        assert!(is_verified("Vercel-Labs/agent-skills"));
        assert!(!is_verified("someone/skills"));
        assert!(!is_verified("anthropics-fan/skills"));
    }

    #[test]
    fn what_skills_sh_answers_is_sorted_and_filtered() {
        let answer = json!({ "skills": [
            { "source": "someone/skills", "skillId": "popular", "name": "popular", "installs": 900 },
            { "source": "anthropics/skills", "skillId": "pdf", "name": "pdf", "installs": 10 },
            { "source": "vercel-labs/agent-skills", "skillId": "react", "installs": 50 },
            { "source": "bad source", "skillId": "x", "installs": 1 },
            { "source": "someone/skills", "skillId": "../climb", "installs": 1 },
        ] });
        let all: Vec<_> = found_skills(&answer, false).into_iter().map(|s| (s.skill_id, s.verified)).collect();
        assert_eq!(all, [("react".to_string(), true), ("pdf".to_string(), true), ("popular".to_string(), false)]);
        let verified: Vec<_> = found_skills(&answer, true).into_iter().map(|s| s.name).collect();
        assert_eq!(verified, ["react", "pdf"]);
        assert!(found_skills(&json!({}), false).is_empty());
    }

    #[test]
    fn a_skills_folder_is_found_by_its_name() {
        let repo = paths(&[
            "README.md", "skills/pdf/SKILL.md", "skills/pdf/scripts/fill.py", "skills/docx/SKILL.md",
            "examples/pdf/notes/SKILL.md.txt", "archive/old/pdf/SKILL.md",
        ]);
        assert_eq!(skill_dir(&repo, "pdf").as_deref(), Some("skills/pdf"));
        assert_eq!(skill_dir(&repo, "docx").as_deref(), Some("skills/docx"));
        assert_eq!(skill_dir(&repo, "xlsx"), None);
        // A repository that is one skill.
        assert_eq!(skill_dir(&paths(&["SKILL.md", "README.md"]), "whatever").as_deref(), Some(""));
        assert_eq!(skill_dir(&paths(&["only/SKILL.md"]), "another-name").as_deref(), Some("only"));
        assert_eq!(skill_dir(&paths(&["NOT-SKILL.md"]), "x"), None);
    }

    #[test]
    fn a_file_is_written_only_below_the_skills_folder() {
        assert_eq!(safe_relative("SKILL.md"), Some(PathBuf::from("SKILL.md")));
        assert_eq!(safe_relative("scripts/run.py"), Some(PathBuf::from("scripts").join("run.py")));
        for bad in ["", "../SKILL.md", "a/../../b", "a//b", "c:/x", "a\\b", "./a"] {
            assert_eq!(safe_relative(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_folder_that_was_not_listed_is_neither_copied_nor_removed() {
        let stray = std::env::temp_dir().join(format!("coucou-stray-skill-{}", std::process::id()));
        std::fs::create_dir_all(&stray).unwrap();
        std::fs::write(stray.join("SKILL.md"), "---\nname: stray\n---\n").unwrap();
        let path = stray.to_string_lossy().into_owned();
        assert!(skill_remove(path.clone()).is_err());
        assert!(skill_copy(path, String::new()).is_err());
        assert!(stray.join("SKILL.md").exists());
        // Nor is anything added anywhere but the user's skills or a known project.
        assert!(dest_root(&stray.to_string_lossy()).is_err());
        let _ = std::fs::remove_dir_all(&stray);
    }
}
