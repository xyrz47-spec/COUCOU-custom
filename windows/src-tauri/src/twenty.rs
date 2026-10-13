// Twenty questions, answered by JEV.
//
// Coucou thinks of something — one of thousands of animals, foods,
// objects, places, jobs, things of nature, Pokémon, characters, body parts and
// activities — thousands of them (twenty_items.txt), by kind and by
// how rare — and keeps it in Rust: the page never sees it until the game is over. The player asks yes/no
// questions, up to twenty; JEV answers each one with a Noul question ("is this
// statement true?") about the secret, which comes back as a value from 0 to 1
// that the tab turns into Yes / Probably yes / Not sure / Probably no / No. A
// guess counts as a question; whether it names the secret is also JEV's call,
// so a translation or a synonym counts.
//
// It needs a TypeSafe API key (Settings → JEV). Each question is one call with
// the secret's name and the player's question — nothing else is sent. Without a
// key, or with the feature off, no game starts.

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;

use crate::jev::{call, KEY};
use crate::{secrets, Shared};

pub const TOTAL: usize = 20;
const MAX_QUESTION_CHARS: usize = 200;
const MAX_GUESS_CHARS: usize = 60;

/// One thing Coucou may think of.
#[derive(Debug, Clone, PartialEq)]
pub struct Item {
    pub kind: &'static str,
    pub en: &'static str,
    /// The name in each of LANGS, English first.
    pub names: Vec<&'static str>,
}

impl Item {
    /// The name in `lang` (one of LANGS), else the English one.
    pub fn name(&self, lang: &str) -> &'static str {
        LANGS.iter().position(|l| *l == lang).and_then(|i| self.names.get(i).copied()).unwrap_or(self.en)
    }
}

/// The interface languages, in the order of the columns of twenty_items.txt (src/i18n/i18n.ts LANGUAGE_CODES).
pub const LANGS: &[&str] = &["en", "ko", "zh-Hans", "hi", "es", "ar", "fr", "bn", "pt-BR", "ru", "id"];

const ITEMS_TEXT: &str = include_str!("twenty_items.txt");

/// The kinds a game may be about.
pub const KINDS: &[&str] = &["animal", "food", "thing", "place", "job", "nature", "pokemon", "character", "body", "activity"];

/// What Coucou may think of, from twenty_items.txt: `kind | English | 한국어 | 简体中文 | …` per line, one name per LANGS.
pub fn items() -> &'static [Item] {
    static ITEMS: OnceLock<Vec<Item>> = OnceLock::new();
    ITEMS.get_or_init(|| {
        ITEMS_TEXT
            .lines()
            .filter(|l| !l.trim().is_empty() && !l.starts_with('#'))
            .filter_map(|line| {
                let mut parts = line.split('|').map(str::trim);
                let kind = parts.next()?;
                let names: Vec<&'static str> = parts.collect();
                (names.len() == LANGS.len()).then(|| Item { kind, en: names[0], names })
            })
            .collect()
    })
}

/// How many of the last picks are not drawn again.
const RECENT: usize = 60;

/// The indexes Coucou may draw for `kind` ("any" for all).
pub fn pool(kind: &str) -> Vec<usize> {
    items()
        .iter()
        .enumerate()
        .filter(|(_, item)| kind == "any" || item.kind == kind)
        .map(|(i, _)| i)
        .collect()
}

/// A random number each call: xorshift64*, seeded once from the clock and the process.
pub fn random() -> u64 {
    static STATE: Mutex<u64> = Mutex::new(0);
    let mut x = STATE.lock().unwrap();
    if *x == 0 {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(1);
        *x = nanos ^ ((std::process::id() as u64) << 32) ^ (&*x as *const u64 as u64) | 1;
    }
    *x ^= *x >> 12;
    *x ^= *x << 25;
    *x ^= *x >> 27;
    x.wrapping_mul(0x2545_F491_4F6C_DD1D)
}

/// Draws one of `pool` that is not among `recent`, by `random`; any of the pool when all were recent.
pub fn draw(pool: &[usize], recent: &VecDeque<usize>, random: u64) -> Option<usize> {
    let fresh: Vec<usize> = pool.iter().copied().filter(|i| !recent.contains(i)).collect();
    let from = if fresh.is_empty() { pool } else { &fresh };
    (!from.is_empty()).then(|| from[(random % from.len() as u64) as usize])
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
static RECENT_PICKS: Mutex<VecDeque<usize>> = Mutex::new(VecDeque::new());

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

/// How the state names the kind of the secret.
fn kind_phrase(kind: &str) -> &'static str {
    match kind {
        "animal" => "an animal",
        "food" => "a food or drink",
        "thing" => "an everyday object",
        "place" => "a place",
        "job" => "a job or a role",
        "nature" => "something in nature or the sky",
        "pokemon" => "a Pokémon",
        "character" => "a character from stories, games, cartoons or legends",
        "body" => "a part of the human body or something that happens to it",
        _ => "an activity, game or event",
    }
}

/// What is known of each Pokémon, from pokemon_facts.txt: `English name | facts` per line (generation,
/// types, abilities with their effects, evolution, size, stats, Pokédex entry). JEV answers from these,
/// so "is it from before Generation 4?" or "has it a skin ability?" is not left to its memory.
pub fn facts_of(name: &str) -> Option<&'static str> {
    static FACTS: OnceLock<HashMap<&'static str, &'static str>> = OnceLock::new();
    FACTS
        .get_or_init(|| {
            include_str!("pokemon_facts.txt")
                .lines()
                .filter_map(|line| line.split_once('|'))
                .map(|(name, facts)| (name.trim(), facts.trim()))
                .collect()
        })
        .get(name)
        .copied()
}

/// "ko: 코끼리, fr: éléphant, …": the secret's names in the other languages, so a question or a guess in any of them is understood.
fn other_names(item: &Item) -> String {
    let mut seen = vec![item.en];
    let mut out = Vec::new();
    for (lang, name) in LANGS.iter().zip(&item.names).skip(1) {
        if !seen.contains(name) {
            seen.push(name);
            out.push(format!("{lang}: {name}"));
        }
    }
    out.join(", ")
}

fn ask_body(item: &Item, question: &str) -> Value {
    let (secret, kind) = (item.en, item.kind);
    let mut state = format!(
        "A guessing game of twenty questions. The secret is: {secret} ({}); its name in other languages: {}. The player asks a yes/no question about the secret, \
         in any language. Judge it as an expert who knows this subject well, from the facts below when there are any and from \
         general knowledge otherwise. Be decisive: answer true or false, and stay undecided only when the question is \
         ambiguous or nobody could know.",
        kind_phrase(kind),
        other_names(item)
    );
    if let Some(facts) = (kind == "pokemon").then(|| facts_of(secret)).flatten() {
        state.push_str("\nFacts about the secret (authoritative): ");
        state.push_str(facts);
    }
    json!({
        "state": state,
        "model": "jev-latest",
        "questions": { "answer": { "type": "noul", "instructions": format!("Is this true of the secret? {question}") } }
    })
}

fn same_body(item: &Item, guess: &str) -> Value {
    json!({
        "state": format!("The secret: {} ({})\nThe guess: {guess}", item.en, other_names(item)),
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
    /// How many things Coucou might have thought of.
    pub pool: usize,
}

/// What Coucou had in mind, told when the game is over: the page picks the language.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Secret {
    pub en: String,
    /// The name in each interface language, by its code.
    pub names: std::collections::BTreeMap<String, String>,
}

fn secret_of(item: usize) -> Secret {
    let it = &items()[item];
    Secret { en: it.en.to_string(), names: LANGS.iter().map(|l| (l.to_string(), it.name(l).to_string())).collect() }
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
    pub secret: Option<Secret>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuessResult {
    pub correct: bool,
    pub asked: usize,
    pub left: usize,
    pub over: bool,
    pub secret: Option<Secret>,
}

fn guard(shared: &Shared) -> Result<String, String> {
    if !crate::features::on(&shared.settings.lock().unwrap(), "twenty") {
        return Err("Twenty questions is off in Settings → Features.".into());
    }
    secrets::get(KEY).ok_or_else(|| "No TypeSafe API key: add one in Settings → JEV.".to_string())
}

/// Coucou thinks of something of `kind`, a kind of KINDS or "any".
#[tauri::command]
pub fn twenty_new(shared: State<Shared>, kind: String) -> Result<Started, String> {
    guard(&shared)?;
    if kind != "any" && !KINDS.contains(&kind.as_str()) {
        return Err("Pick a kind of thing.".into());
    }
    let pool = pool(&kind);
    let mut recent = RECENT_PICKS.lock().unwrap();
    let item = draw(&pool, &recent, random()).ok_or("Pick a kind of thing.")?;
    recent.push_back(item);
    while recent.len() > RECENT {
        recent.pop_front();
    }
    *GAME.lock().unwrap() = Some(Game::new(item));
    Ok(Started { total: TOTAL, pool: pool.len() })
}

/// One yes/no question about the secret.
#[tauri::command]
pub async fn twenty_ask(shared: State<'_, Shared>, question: String) -> Result<Answer, String> {
    let key = guard(&shared)?;
    let question: String = question.trim().chars().take(MAX_QUESTION_CHARS).collect();
    if question.is_empty() {
        return Err("Ask a question first.".into());
    }
    let item = {
        let game = GAME.lock().unwrap();
        &items()[game.as_ref().filter(|g| g.can_ask()).ok_or("No game on: start a new one.")?.item]
    };
    let noul = noul_of(&call(&key, &ask_body(item, &question)).await?, "answer")?;
    let mut slot = GAME.lock().unwrap();
    let game = slot.as_mut().filter(|g| g.can_ask()).ok_or("No game on: start a new one.")?;
    game.spend();
    let over = game.over;
    Ok(Answer {
        label: label(noul),
        asked: game.asked,
        left: game.left(),
        over,
        secret: over.then(|| secret_of(game.item)),
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
    let item = {
        let game = GAME.lock().unwrap();
        &items()[game.as_ref().filter(|g| g.can_ask()).ok_or("No game on: start a new one.")?.item]
    };
    let correct = if item.names.iter().any(|n| normalise(n) == normalise(&guess)) {
        true
    } else {
        noul_of(&call(&key, &same_body(item, &guess)).await?, "same")? >= 0.8
    };
    let mut slot = GAME.lock().unwrap();
    let game = slot.as_mut().filter(|g| g.can_ask()).ok_or("No game on: start a new one.")?;
    game.guess(correct);
    Ok(GuessResult {
        correct,
        asked: game.asked,
        left: game.left(),
        over: game.over,
        secret: game.over.then(|| secret_of(game.item)),
    })
}

/// Gives up: the secret is told and the game ends.
#[tauri::command]
pub fn twenty_give_up() -> Result<Secret, String> {
    let mut slot = GAME.lock().unwrap();
    let game = slot.as_mut().ok_or("No game on.")?;
    game.over = true;
    Ok(secret_of(game.item))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn find(en: &str) -> &'static Item {
        items().iter().find(|i| i.en == en).unwrap_or_else(|| panic!("no {en}"))
    }

    #[test]
    fn the_list_is_large_valid_and_every_english_name_is_unique() {
        let all = items();
        assert!(all.len() >= 4000, "{} things", all.len());
        let mut names: Vec<String> = all.iter().map(|i| normalise(i.en)).collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), all.len(), "an English name is used twice");
        for item in all {
            assert!(KINDS.contains(&item.kind), "{}: kind {}", item.en, item.kind);
            assert_eq!(item.names.len(), LANGS.len(), "{}", item.en);
            assert!(item.names.iter().all(|n| !n.is_empty() && !n.contains('|')), "{}: an empty name", item.en);
        }
        let lines = ITEMS_TEXT.lines().filter(|l| !l.trim().is_empty() && !l.starts_with('#')).count();
        assert_eq!(lines, all.len(), "a line of twenty_items.txt could not be read");
    }

    #[test]
    fn every_thing_has_a_name_in_every_interface_language() {
        let elephant = find("Elephant");
        assert_eq!(elephant.name("ko"), "코끼리");
        assert_eq!(elephant.name("xx"), "Elephant", "an unknown language falls back to English");
        for lang in LANGS {
            assert!(!elephant.name(lang).is_empty(), "{lang}");
        }
        let secret = secret_of(items().iter().position(|i| i.en == "Pikachu").unwrap());
        assert_eq!(secret.names["ko"], "피카츄");
        assert_eq!(secret.names["fr"], "Pikachu");
        assert_eq!(secret.names.len(), LANGS.len());
        let langs: Vec<&str> = include_str!("../../src/i18n/i18n.ts")
            .split("LANGUAGE_CODES = [")
            .nth(1)
            .and_then(|rest| rest.split(']').next())
            .unwrap()
            .split(',')
            .map(|code| code.trim().trim_matches('"'))
            .collect();
        let mut theirs = langs.clone();
        theirs.sort();
        let mut ours = LANGS.to_vec();
        ours.sort();
        assert_eq!(ours, theirs, "twenty_items.txt has a column for each interface language");
    }

    #[test]
    fn the_names_are_written_in_each_language_s_own_script() {
        // Everyday things (not characters or Pokémon, which may keep their own names): nearly all
        // are written in the script of the language, so a column was not left in English.
        let everyday: Vec<&Item> = items().iter().filter(|i| i.kind != "character" && i.kind != "pokemon").collect();
        let scripts: [(&str, fn(char) -> bool); 6] = [
            ("ko", |c| ('\u{AC00}'..='\u{D7A3}').contains(&c)),
            ("zh-Hans", |c| ('\u{4E00}'..='\u{9FFF}').contains(&c)),
            ("hi", |c| ('\u{0900}'..='\u{097F}').contains(&c)),
            ("ar", |c| ('\u{0600}'..='\u{06FF}').contains(&c)),
            ("bn", |c| ('\u{0980}'..='\u{09FF}').contains(&c)),
            ("ru", |c| ('\u{0400}'..='\u{04FF}').contains(&c)),
        ];
        for (lang, script) in scripts {
            let written = everyday.iter().filter(|i| i.name(lang).chars().any(script)).count();
            assert!(written * 100 >= everyday.len() * 95, "{lang}: {written} of {}", everyday.len());
        }
        for lang in ["es", "fr", "pt-BR", "id"] {
            let own = everyday.iter().filter(|i| i.name(lang) != i.en).count();
            assert!(own * 100 >= everyday.len() * 60, "{lang}: {own} of {} differ from English", everyday.len());
        }
    }

    #[test]
    fn every_kind_has_plenty() {
        for kind in KINDS {
            assert!(pool(kind).len() >= 90, "{kind}: {}", pool(kind).len());
        }
        assert!(pool("any").len() >= 4000);
        assert!(pool("animal").iter().all(|&i| items()[i].kind == "animal"));
        assert!(pool("vegetable").is_empty());
    }

    #[test]
    fn jev_gets_the_facts_of_a_pokemon_so_it_need_not_remember_them() {
        for i in pool("pokemon") {
            assert!(facts_of(items()[i].en).is_some(), "no facts for {}", items()[i].en);
        }
        let body = ask_body(find("Rhydon"), "4세대 전 포켓몬이야?");
        let state = body["state"].as_str().unwrap();
        assert!(state.contains("코뿌리") && state.contains("Generation 1 (Kanto)") && state.contains("before Generation 4"), "{state}");
        assert!(state.contains("Rock Head") && state.contains("Evolution: evolved 1 time(s); evolves from Rhyhorn"));
        assert!(state.contains("Weaknesses/resistances") && state.contains("Moves it can learn") && state.contains("Smogon singles tier"));
        let skin = ask_body(find("Mega Dragonite"), "스킨 특성이 있어?");
        assert!(facts_of("Sylveon").unwrap().contains("Pixilate") && facts_of("Sylveon").unwrap().contains("'Skin' ability"));
        assert!(skin["state"].as_str().unwrap().contains("Mega Evolution of Dragonite"));
        let plain = ask_body(find("Elephant"), "Is it big?");
        assert!(!plain["state"].as_str().unwrap().contains("Facts about"));
    }

    #[test]
    fn every_pokemon_is_in_the_pool_with_its_megas() {
        let names: Vec<&str> = pool("pokemon").iter().map(|&i| items()[i].en).collect();
        let species = names.iter().filter(|n| !n.starts_with("Mega ")).count();
        assert_eq!(species, 1025, "the National Pokédex has 1025 species");
        for must in ["Bulbasaur", "Pecharunt", "Mega Charizard X", "Mega Charizard Y", "Mega Mewtwo Y", "Mega Clefable", "Mega Garchomp Z", "Mega Raichu X"] {
            assert!(names.contains(&must), "{must}");
        }
        assert!(names.len() >= 1025 + 90, "{} with the Megas", names.len());
    }

    #[test]
    fn the_draw_is_spread_over_the_pool_and_skips_what_was_played_lately() {
        let big = pool("any");
        let mut seen = std::collections::HashSet::new();
        let mut recent = VecDeque::new();
        for _ in 0..400 {
            let pick = draw(&big, &recent, random()).unwrap();
            assert!(!recent.contains(&pick), "a recent pick came again");
            seen.insert(pick);
            recent.push_back(pick);
            if recent.len() > RECENT {
                recent.pop_front();
            }
        }
        assert!(seen.len() >= 330, "only {} different things in 400 games", seen.len());
        let small = vec![5, 6];
        let recent: VecDeque<usize> = [5].into_iter().collect();
        assert!((0..20).all(|n| draw(&small, &recent, n) == Some(6)));
        let all_recent: VecDeque<usize> = [5, 6].into_iter().collect();
        assert!(draw(&small, &all_recent, 3).is_some(), "when all were recent, any may come");
        assert_eq!(draw(&[], &VecDeque::new(), 1), None);
        assert_ne!(random(), random());
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
        let body = ask_body(find("Elephant"), "Is it bigger than a car?");
        let state = body["state"].as_str().unwrap();
        assert!(state.contains("Elephant") && state.contains("an animal"));
        assert!(kind_phrase("pokemon").contains("Pokémon") && kind_phrase("body").contains("body"));
        for kind in KINDS {
            assert!(!kind_phrase(kind).contains("event") || *kind == "activity", "{kind} has its own phrase");
        }
        assert_eq!(body["questions"]["answer"]["type"], "noul");
        assert!(body["questions"]["answer"]["instructions"].as_str().unwrap().ends_with("Is it bigger than a car?"));
        assert_eq!(body["model"], "jev-latest");
        let same = same_body(find("Elephant"), "코끼리");
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
