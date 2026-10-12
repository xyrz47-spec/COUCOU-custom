// Valorant match reviews — the local store.
//
// A review is what the post-match analysis produces for one recorded match:
// a few things done well, the one to three habits most worth fixing, and the
// moments they come from. Each moment carries a timestamp inside the video,
// what could be seen (the fact), what is inferred from it, why, what else
// could have been done, how sure that is, and one drill to practise.
//
// This file is the store and the check every review passes before it is kept
// or shown: a moment outside the video, a moment with no observed fact or no
// stated uncertainty, or more than three main issues is refused, so a review
// cannot claim what the footage does not hold. Reviews live as one JSON file
// each under platform::local_dir()/valorant/reviews and never leave the
// machine from here; the user can delete one or all of them.
//
// Recording the match and asking an AI model for the analysis are not here:
// they need the game window's capture and the JEV API, which are separate
// pieces of work.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::platform;

/// What a moment is about, as the analysis names it.
pub const CATEGORIES: &[&str] = &[
    "aim", "abilities", "positioning", "teamwork", "round-management", "economy", "ultimate",
];
const MAX_TOP_ISSUES: usize = 3;
const MAX_FINDINGS: usize = 200;
const MAX_TEXT: usize = 2000;
/// A review file larger than this was not written by us.
const MAX_FILE_BYTES: u64 = 2 << 20;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Finding {
    pub start_ms: u64,
    pub end_ms: u64,
    pub category: String,
    /// What can be seen in the footage.
    pub fact: String,
    /// What follows from it, said as an inference.
    pub inference: String,
    pub reasoning: String,
    /// What else could have been done, and why.
    pub alternative: String,
    /// How sure this is, and what the footage cannot show.
    pub uncertainty: String,
    /// One thing to practise.
    pub drill: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Review {
    /// Letters, digits, `-` and `_` only: it names the file.
    pub id: String,
    pub created_at: i64,
    pub video_ms: u64,
    pub did_well: Vec<String>,
    /// The one to three habits most worth changing.
    pub top_issues: Vec<String>,
    pub next_goal: String,
    pub findings: Vec<Finding>,
    /// The user's own correction or comment.
    pub user_note: String,
}

fn too_long(texts: &[&str]) -> bool {
    texts.iter().any(|t| t.chars().count() > MAX_TEXT)
}

/// `Ok` when the review claims nothing the footage cannot hold.
pub fn validate(review: &Review) -> Result<(), String> {
    if !is_id(&review.id) {
        return Err("the review's id is not a plain name".into());
    }
    if review.video_ms == 0 {
        return Err("the review does not say how long the video is".into());
    }
    if review.top_issues.is_empty() || review.top_issues.len() > MAX_TOP_ISSUES {
        return Err(format!("a review names between 1 and {MAX_TOP_ISSUES} main issues"));
    }
    if review.findings.len() > MAX_FINDINGS {
        return Err("too many moments".into());
    }
    for (n, f) in review.findings.iter().enumerate() {
        let at = n + 1;
        if f.start_ms >= f.end_ms || f.end_ms > review.video_ms {
            return Err(format!("moment {at} is not inside the video"));
        }
        if !CATEGORIES.contains(&f.category.as_str()) {
            return Err(format!("moment {at} has an unknown category"));
        }
        if f.fact.trim().is_empty() || f.uncertainty.trim().is_empty() {
            return Err(format!("moment {at} needs what was seen and how sure it is"));
        }
        if too_long(&[&f.fact, &f.inference, &f.reasoning, &f.alternative, &f.uncertainty, &f.drill]) {
            return Err(format!("moment {at} is too long"));
        }
    }
    if too_long(&[&review.next_goal, &review.user_note]) {
        return Err("the goal or the note is too long".into());
    }
    Ok(())
}

pub fn is_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn dir() -> PathBuf {
    platform::local_dir().join("valorant").join("reviews")
}

fn path_in(dir: &std::path::Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.json"))
}

/// Keeps `review` (written whole to a temporary file, then renamed over).
fn save_in(dir: &std::path::Path, review: &Review) -> Result<(), String> {
    validate(review)?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let target = path_in(dir, &review.id);
    let temp = target.with_extension("json.tmp");
    let text = serde_json::to_vec_pretty(review).map_err(|e| e.to_string())?;
    fs::write(&temp, text).map_err(|e| e.to_string())?;
    fs::rename(&temp, &target).map_err(|e| e.to_string())
}

/// The valid reviews, newest first, and how many files were set aside.
fn list_in(dir: &std::path::Path) -> (Vec<Review>, usize) {
    let mut reviews = Vec::new();
    let mut skipped = 0;
    let Ok(entries) = fs::read_dir(dir) else { return (reviews, 0) };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|x| x != "json") {
            continue;
        }
        let ok = fs::metadata(&path).is_ok_and(|m| m.len() <= MAX_FILE_BYTES)
            && fs::read(&path)
                .ok()
                .and_then(|b| serde_json::from_slice::<Review>(&b).ok())
                .filter(|r| validate(r).is_ok())
                .map(|r| reviews.push(r))
                .is_some();
        if !ok {
            skipped += 1;
        }
    }
    reviews.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(a.id.cmp(&b.id)));
    (reviews, skipped)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewList {
    pub reviews: Vec<Review>,
    /// Files in the folder that are not valid reviews: kept, not read.
    pub skipped: usize,
}

#[tauri::command(async)]
pub fn valorant_reviews() -> ReviewList {
    let (reviews, skipped) = list_in(&dir());
    ReviewList { reviews, skipped }
}

/// The user's correction or comment on a review.
#[tauri::command(async)]
pub fn valorant_review_note(id: String, note: String) -> Result<(), String> {
    let dir = dir();
    let mut review = read_one(&dir, &id)?;
    review.user_note = note;
    save_in(&dir, &review)
}

fn read_one(dir: &std::path::Path, id: &str) -> Result<Review, String> {
    if !is_id(id) {
        return Err("that is not a review".into());
    }
    let bytes = fs::read(path_in(dir, id)).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

fn delete_in(dir: &std::path::Path, id: Option<&str>) -> Result<usize, String> {
    let mut gone = 0;
    let Ok(entries) = fs::read_dir(dir) else { return Ok(0) };
    for entry in entries.flatten() {
        let path = entry.path();
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        if path.extension().is_none_or(|x| x != "json") || !is_id(stem) {
            continue;
        }
        if id.is_none_or(|wanted| wanted == stem) {
            fs::remove_file(&path).map_err(|e| e.to_string())?;
            gone += 1;
        }
    }
    Ok(gone)
}

/// Deletes one review.
#[tauri::command(async)]
pub fn valorant_review_delete(id: String) -> Result<usize, String> {
    if !is_id(&id) {
        return Err("that is not a review".into());
    }
    delete_in(&dir(), Some(&id))
}

/// Deletes every review.
#[tauri::command(async)]
pub fn valorant_reviews_delete_all() -> Result<usize, String> {
    delete_in(&dir(), None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn moment() -> Finding {
        Finding {
            start_ms: 1_000,
            end_ms: 4_000,
            category: "positioning".into(),
            fact: "Peeks the corridor without cover while two enemies are listed alive.".into(),
            uncertainty: "Enemy positions off screen are unknown.".into(),
            ..Finding::default()
        }
    }

    fn review(id: &str) -> Review {
        Review {
            id: id.into(),
            created_at: 10,
            video_ms: 60_000,
            top_issues: vec!["Wide peeks without cover".into()],
            findings: vec![moment()],
            ..Review::default()
        }
    }

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("coucou-valorant-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn a_review_claims_nothing_outside_the_footage() {
        assert!(validate(&review("m1")).is_ok());
        let mut r = review("m1");
        r.findings[0].end_ms = 60_001;
        assert!(validate(&r).is_err(), "after the video ends");
        r.findings[0].end_ms = 1_000;
        assert!(validate(&r).is_err(), "no duration");
        let mut r = review("m1");
        r.findings[0].fact = "  ".into();
        assert!(validate(&r).is_err(), "no observed fact");
        let mut r = review("m1");
        r.findings[0].uncertainty.clear();
        assert!(validate(&r).is_err(), "no stated uncertainty");
        let mut r = review("m1");
        r.findings[0].category = "vibes".into();
        assert!(validate(&r).is_err());
        let mut r = review("m1");
        r.top_issues = vec!["a".into(), "b".into(), "c".into(), "d".into()];
        assert!(validate(&r).is_err(), "more than three issues");
        r.top_issues.clear();
        assert!(validate(&r).is_err(), "no issue");
        assert!(validate(&review("../escape")).is_err());
    }

    #[test]
    fn reviews_are_kept_listed_newest_first_and_deleted() {
        let dir = temp("store");
        let mut old = review("old");
        old.created_at = 1;
        save_in(&dir, &old).unwrap();
        save_in(&dir, &review("new")).unwrap();
        assert!(save_in(&dir, &review("bad id")).is_err());
        // A file that is not a review is set aside, never read or deleted by "list".
        fs::write(dir.join("stray.json"), "{oops").unwrap();
        let (listed, skipped) = list_in(&dir);
        assert_eq!(listed.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["new", "old"]);
        assert_eq!(skipped, 1);

        let mut noted = read_one(&dir, "new").unwrap();
        noted.user_note = "The enemy was not on screen: ignore this one.".into();
        save_in(&dir, &noted).unwrap();
        assert_eq!(read_one(&dir, "new").unwrap().user_note, noted.user_note);

        assert_eq!(delete_in(&dir, Some("old")).unwrap(), 1);
        assert_eq!(list_in(&dir).0.len(), 1);
        assert_eq!(delete_in(&dir, None).unwrap(), 2);
        assert!(list_in(&dir).0.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }
}
