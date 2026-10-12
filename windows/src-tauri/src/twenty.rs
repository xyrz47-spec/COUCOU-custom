// Twenty questions, answered by JEV.
//
// Coucou thinks of something — an animal, a food, an object — and keeps it in
// Rust: the page never sees it until the game is over. The player asks yes/no
// questions, up to twenty; JEV answers each one with a Noul question ("is this
// statement true?") about the secret, which comes back as a value from 0 to 1
// that the tab turns into Yes / Probably yes / Not sure / Probably no / No. A
// guess counts as a question; whether it names the secret is also JEV's call,
// so a translation or a synonym counts.
//
// It needs a TypeSafe API key (Settings → JEV). Each question is one call with
// the secret's name and the player's question — nothing else is sent. Without a
// key, or with the feature off, no game starts.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;

use crate::jev::{call, KEY};
use crate::{secrets, Shared};

pub const TOTAL: usize = 20;
const MAX_QUESTION_CHARS: usize = 200;
const MAX_GUESS_CHARS: usize = 60;

/// What Coucou may think of: (kind, name). Names are English; the tab translates them when the game ends.
pub const ITEMS: &[(&str, &str)] = &[
    ("animal", "Elephant"), ("animal", "Dog"), ("animal", "Penguin"),
    ("animal", "Dolphin"), ("animal", "Butterfly"), ("animal", "Giraffe"),
    ("food", "Pizza"), ("food", "Banana"), ("food", "Ice cream"),
    ("food", "Bread"), ("food", "Egg"), ("food", "Rice"),
    ("thing", "Umbrella"), ("thing", "Bicycle"), ("thing", "Telephone"),
    ("thing", "Clock"), ("thing", "Book"), ("thing", "Toothbrush"),
];

/// The index of the item to think of: of `kind` ("any" for all), by `seed`, not `last` if there is another.
pub fn pick(kind: &str, seed: u64, last: Option<usize>) -> Option<usize> {
    let pool: Vec<usize> = ITEMS.iter().enumerate().filter(|(_, (k, _))| kind == "any" || *k == kind).map(|(i, _)| i).collect();
    if pool.is_empty() {
        return None;
    }
    let mut at = (seed % pool.len() as u64) as usize;
    if pool.len() > 1 && Some(pool[at]) == last {
        at = (at + 1) % pool.len();
    }
    Some(pool[at])
}

#[derive(Debug, Clone, PartialEq)]
pub struct Game {
    item: usize,
    asked: usize,
    over: bool,
}

impl Game {
    pub fn new(item: usize) -> Game {
        Game { item, asked: 0, over: false }
    }
    pub fn left(&self) -> usize {
        TOTAL - self.asked
    }
    /// A question or a guess may be made: the game is on and there are questions left.
    pub fn can_ask(&self) -> bool {
        !self.over && self.asked < TOTAL
    }
    fn spend(&mut self) {
        self.asked += 1;
        if self.asked >= TOTAL {
            self.over = true;
        }
    }
    /// A guess was made: it uses a question; a right one wins, the last wrong one loses.
    fn guess(&mut self, correct: bool) {
        self.spend();
        if correct {
            self.over = true;
        }
    }
}

static GAME: Mutex<Option<Game>> = Mutex::new(None);
static LAST: Mutex<Option<usize>> = Mutex::new(None);

/// The answer to a question, from JEV's 0–1.
pub fn label(noul: f64) -> &'static str {
    match noul {
        n if n >= 0.85 => "yes",
        n if n >= 0.6 => "probablyYes",
        n if n > 0.4 => "unsure",
        n if n > 0.15 => "probablyNo",
        _ => "no",
    }
}

/// Letters and digits only, lowercase: "Ice  cream!" and "ice cream" are the same.
pub fn normalise(text: &str) -> String {
    text.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

fn ask_body(secret: &str, kind: &str, question: &str) -> Value {
    json!({
        "state": format!("A guessing game of twenty questions. The secret is: {secret} (a kind of {kind}). The player asks a yes/no question about the secret."),
        "model": "jev-latest",
        "questions": { "answer": { "type": "noul", "instructions": question } }
    })
}

fn same_body(secret: &str, guess: &str) -> Value {
    json!({
        "state": format!("The secret: {secret}\nThe guess: {guess}"),
        "model": "jev-latest",
        "questions": { "same": { "type": "noul", "instructions": "The guess names the same thing as the secret. A translation, a plural or a close synonym counts." } }
    })
}

fn noul_of(response: &Value, name: &str) -> Result<f64, String> {
    response
        .get("answers")
        .and_then(|a| a.get(name))
        .and_then(|a| a.get("noul"))
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite())
        .map(|n| n.clamp(0.0, 1.0))
        .ok_or_else(|| format!("the answer holds no \"{name}\""))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    pub total: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    /// yes, probablyYes, unsure, probablyNo or no.
    pub label: &'static str,
    pub asked: usize,
    pub left: usize,
    /// The questions ran out without a guess: the game is over.
    pub over: bool,
    /// The secret, once the game is over.
    pub secret: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuessResult {
    pub correct: bool,
    pub asked: usize,
    pub left: usize,
    pub over: bool,
    pub secret: Option<String>,
}

fn guard(shared: &Shared) -> Result<String, String> {
    if !crate::features::on(&shared.settings.lock().unwrap(), "twenty") {
        return Err("Twenty questions is off in Settings → Features.".into());
    }
    secrets::get(KEY).ok_or_else(|| "No TypeSafe API key: add one in Settings → JEV.".to_string())
}

/// Coucou thinks of something of `kind` ("animal", "food", "thing" or "any").
#[tauri::command]
pub fn twenty_new(shared: State<Shared>, kind: String) -> Result<Started, String> {
    guard(&shared)?;
    let seed = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(7);
    let mut last = LAST.lock().unwrap();
    let item = pick(&kind, seed, *last).ok_or("Pick animal, food, thing or any.")?;
    *last = Some(item);
    *GAME.lock().unwrap() = Some(Game::new(item));
    Ok(Started { total: TOTAL })
}

/// One yes/no question about the secret.
#[tauri::command]
pub async fn twenty_ask(shared: State<'_, Shared>, question: String) -> Result<Answer, String> {
    let key = guard(&shared)?;
    let question: String = question.trim().chars().take(MAX_QUESTION_CHARS).collect();
    if question.is_empty() {
        return Err("Ask a question first.".into());
    }
    let (kind, name) = {
        let game = GAME.lock().unwrap();
        let game = game.as_ref().filter(|g| g.can_ask()).ok_or("No game on: start a new one.")?;
        ITEMS[game.item]
    };
    let noul = noul_of(&call(&key, &ask_body(name, kind, &question)).await?, "answer")?;
    let mut slot = GAME.lock().unwrap();
    let game = slot.as_mut().filter(|g| g.can_ask()).ok_or("No game on: start a new one.")?;
    game.spend();
    let over = game.over;
    Ok(Answer {
        label: label(noul),
        asked: game.asked,
        left: game.left(),
        over,
        secret: over.then(|| ITEMS[game.item].1.to_string()),
    })
}

/// A guess. It uses a question; a right one wins.
#[tauri::command]
pub async fn twenty_guess(shared: State<'_, Shared>, guess: String) -> Result<GuessResult, String> {
    let key = guard(&shared)?;
    let guess: String = guess.trim().chars().take(MAX_GUESS_CHARS).collect();
    if guess.is_empty() {
        return Err("Type a guess first.".into());
    }
    let name = {
        let game = GAME.lock().unwrap();
        ITEMS[game.as_ref().filter(|g| g.can_ask()).ok_or("No game on: start a new one.")?.item].1
    };
    let correct = if normalise(&guess) == normalise(name) {
        true
    } else {
        noul_of(&call(&key, &same_body(name, &guess)).await?, "same")? >= 0.8
    };
    let mut slot = GAME.lock().unwrap();
    let game = slot.as_mut().filter(|g| g.can_ask()).ok_or("No game on: start a new one.")?;
    game.guess(correct);
    Ok(GuessResult {
        correct,
        asked: game.asked,
        left: game.left(),
        over: game.over,
        secret: game.over.then(|| ITEMS[game.item].1.to_string()),
    })
}

/// Gives up: the secret is told and the game ends.
#[tauri::command]
pub fn twenty_give_up() -> Result<String, String> {
    let mut slot = GAME.lock().unwrap();
    let game = slot.as_mut().ok_or("No game on.")?;
    game.over = true;
    Ok(ITEMS[game.item].1.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_thinks_of_something_of_the_kind_asked_and_not_the_same_twice() {
        for seed in 0..50 {
            let i = pick("animal", seed, None).unwrap();
            assert_eq!(ITEMS[i].0, "animal");
        }
        let any: std::collections::HashSet<_> = (0..50).filter_map(|s| pick("any", s, None)).map(|i| ITEMS[i].0).collect();
        assert_eq!(any.len(), 3, "any reaches every kind");
        let first = pick("food", 3, None).unwrap();
        assert_ne!(pick("food", 3, Some(first)).unwrap(), first, "not the one just played");
        assert_eq!(pick("vegetable", 1, None), None);
    }

    #[test]
    fn every_kind_has_several_items_and_each_name_once() {
        for kind in ["animal", "food", "thing"] {
            assert!(ITEMS.iter().filter(|(k, _)| *k == kind).count() >= 5, "{kind}");
        }
        let mut names: Vec<_> = ITEMS.iter().map(|(_, n)| normalise(n)).collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), ITEMS.len());
    }

    #[test]
    fn jevs_number_becomes_five_answers() {
        assert_eq!(
            [1.0, 0.85, 0.7, 0.5, 0.3, 0.1, 0.0].map(label),
            ["yes", "yes", "probablyYes", "unsure", "probablyNo", "no", "no"],
        );
    }

    #[test]
    fn twenty_questions_then_the_game_is_over_and_a_right_guess_ends_it_early() {
        let mut game = Game::new(0);
        for n in 1..=TOTAL {
            assert!(game.can_ask());
            game.spend();
            assert_eq!((game.asked, game.left()), (n, TOTAL - n));
        }
        assert!(!game.can_ask() && game.over);

        let mut won = Game::new(0);
        won.guess(false);
        assert!(won.can_ask() && won.asked == 1, "a wrong guess costs a question and the game goes on");
        won.guess(true);
        assert!(!won.can_ask() && won.asked == 2, "a right guess ends it");

        let mut lost = Game::new(0);
        for _ in 0..TOTAL {
            lost.guess(false);
        }
        assert!(lost.over && lost.left() == 0);
    }

    #[test]
    fn the_secret_goes_to_jev_with_the_question_and_nothing_else() {
        let body = ask_body("Elephant", "animal", "Is it bigger than a car?");
        let state = body["state"].as_str().unwrap();
        assert!(state.contains("Elephant") && state.contains("animal"));
        assert_eq!(body["questions"]["answer"]["type"], "noul");
        assert_eq!(body["questions"]["answer"]["instructions"], "Is it bigger than a car?");
        assert_eq!(body["model"], "jev-latest");
        let same = same_body("Elephant", "코끼리");
        assert!(same["state"].as_str().unwrap().contains("코끼리"));
        assert!(same["questions"]["same"]["instructions"].as_str().unwrap().contains("translation"));
    }

    #[test]
    fn a_guess_is_compared_without_case_spaces_or_marks_and_an_odd_answer_is_an_error() {
        assert_eq!(normalise(" Ice  CREAM! "), normalise("ice cream"));
        assert_ne!(normalise("Egg"), normalise("Eggs"));
        let ok = json!({"answers":{"answer":{"type":"noul","noul":0.9}}});
        assert_eq!(noul_of(&ok, "answer").unwrap(), 0.9);
        assert_eq!(noul_of(&json!({"answers":{"answer":{"noul":4.0}}}), "answer").unwrap(), 1.0, "kept in range");
        assert!(noul_of(&json!({}), "answer").is_err());
        assert!(noul_of(&json!({"answers":{"answer":{}}}), "answer").is_err());
    }
}
