// JEV (TypeSafe's System One model): helping to pick, in everyday life.
//
// The Decide tab takes how the person feels ("tired, something warm") and a few
// options they type, one per line — what to eat, what to drink, what to do —
// and asks JEV one typed Choice question: which of these fits best? JEV answers
// with a probability for each option, so the tab can show a ranking instead of
// one verdict. JEV picks among the options given; it does not make any up.
//
// It needs a TypeSafe API key (Settings → JEV, kept in the credential store,
// never on disk). Without one, or with the feature off, nothing is sent. What
// is sent is the feeling and the options typed, and only when the user presses
// Decide.
//
// The API: POST https://api.typesafe.ai/v1/systemone with a Bearer key, a
// `state` and typed `questions` (docs.typesafe.ai).

use std::collections::HashMap;
use std::time::Duration;

use reqwest::Url;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;

use crate::{net, secrets, Shared};

const ENDPOINT: &str = "https://api.typesafe.ai/v1/systemone";
pub const KEY: &str = "typesafe-api-key";
const MODEL: &str = "jev-latest";
const TIMEOUT: Duration = Duration::from_secs(10);
pub const MIN_OPTIONS: usize = 2;
pub const MAX_OPTIONS: usize = 10;
const MAX_OPTION_CHARS: usize = 60;
const MAX_FEELING_CHARS: usize = 200;

/// The options typed, trimmed, each once (whatever the case), at most MAX_OPTIONS.
pub fn clean_options(options: &[String]) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for option in options {
        let option: String = option.trim().chars().take(MAX_OPTION_CHARS).collect();
        if !option.is_empty() && !out.iter().any(|o| o.to_lowercase() == option.to_lowercase()) {
            out.push(option);
        }
    }
    out.truncate(MAX_OPTIONS);
    if out.len() < MIN_OPTIONS {
        return Err(format!("Give at least {MIN_OPTIONS} different options."));
    }
    Ok(out)
}

/// The id JEV is given for option `n`: criteria are keyed by it, the text is the description.
fn option_id(n: usize) -> String {
    format!("o{}", n + 1)
}

pub fn request_body(feeling: &str, options: &[String]) -> Value {
    let feeling: String = feeling.trim().chars().take(MAX_FEELING_CHARS).collect();
    let state = if feeling.is_empty() {
        "The person has no particular preference right now.".to_string()
    } else {
        format!("What the person feels like right now: {feeling}")
    };
    let criteria: serde_json::Map<String, Value> =
        options.iter().enumerate().map(|(n, o)| (option_id(n), Value::String(o.clone()))).collect();
    json!({
        "state": state,
        "model": MODEL,
        "questions": {
            "pick": {
                "type": "choice",
                "instructions": "Which option suits the person best right now",
                "criteria": criteria
            }
        }
    })
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ranked {
    pub option: String,
    /// 0 to 1: JEV's probability for this option; they add up to about 1.
    pub share: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    /// Best first.
    pub ranking: Vec<Ranked>,
    /// 0 to 1: how sure JEV is of the first.
    pub confidence: f64,
}

/// The ranking in a /v1/systemone response for `options`, or why it is not usable.
pub fn decision_from_response(response: &Value, options: &[String]) -> Result<Decision, String> {
    let pick = response.get("answers").and_then(|a| a.get("pick")).ok_or("the answer holds no \"pick\"")?;
    let probabilities: HashMap<String, f64> = pick
        .get("probabilities")
        .and_then(Value::as_object)
        .ok_or("the answer holds no probabilities")?
        .iter()
        .filter_map(|(k, v)| v.as_f64().filter(|p| p.is_finite()).map(|p| (k.clone(), p.clamp(0.0, 1.0))))
        .collect();
    let mut ranking: Vec<Ranked> = options
        .iter()
        .enumerate()
        .map(|(n, option)| Ranked { option: option.clone(), share: probabilities.get(&option_id(n)).copied().unwrap_or(0.0) })
        .collect();
    if ranking.iter().all(|r| r.share == 0.0) {
        return Err("the answer ranks none of the options".into());
    }
    // Best first; options JEV rated the same stay in the order they were typed.
    ranking.sort_by(|a, b| b.share.partial_cmp(&a.share).unwrap_or(std::cmp::Ordering::Equal));
    let confidence = pick.get("confidence").and_then(Value::as_f64).filter(|c| c.is_finite()).unwrap_or(0.0).clamp(0.0, 1.0);
    Ok(Decision { ranking, confidence })
}

fn status_message(status: u16) -> String {
    match status {
        401 | 403 => "TypeSafe refused the API key.".into(),
        402 => "The TypeSafe account has no credit left.".into(),
        429 => "TypeSafe says too many requests: try again in a moment.".into(),
        s => format!("TypeSafe answered {s}."),
    }
}

/// One call to JEV with `body`; the whole response.
async fn call(key: &str, body: &Value) -> Result<Value, String> {
    let url = Url::parse(ENDPOINT).map_err(|e| e.to_string())?;
    let response = net::client(&url, TIMEOUT)?
        .post(url)
        .bearer_auth(key)
        .json(body)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(status_message(status.as_u16()));
    }
    let bytes = net::read_capped(response, net::MAX_BODY).await?;
    serde_json::from_slice(&bytes).map_err(|e| format!("Bad answer from TypeSafe: {e}"))
}

/// Which option suits the person best. Asked only when the user presses Decide, with the saved key.
#[tauri::command]
pub async fn jev_decide(shared: State<'_, Shared>, feeling: String, options: Vec<String>) -> Result<Decision, String> {
    let options = clean_options(&options)?;
    if !crate::features::on(&shared.settings.lock().unwrap(), "decide") {
        return Err("Decide is off in Settings → Features.".into());
    }
    let key = secrets::get(KEY).ok_or("No TypeSafe API key: add one in Settings → JEV.")?;
    decision_from_response(&call(&key, &request_body(&feeling, &options)).await?, &options)
}

/// Asks JEV one harmless question with the saved key, to say whether the key works.
#[tauri::command]
pub async fn jev_check_key() -> Result<String, String> {
    let key = secrets::get(KEY).ok_or("No API key saved.")?;
    let body = json!({
        "state": "Hello!",
        "model": MODEL,
        "questions": { "friendly": { "type": "noul", "instructions": "The message is friendly." } }
    });
    let response = call(&key, &body).await?;
    Ok(response.get("model").and_then(Value::as_str).unwrap_or(MODEL).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn options_are_trimmed_once_each_and_between_two_and_ten() {
        assert_eq!(clean_options(&opts(&[" Ramen ", "ramen", "", "Salad"])).unwrap(), ["Ramen", "Salad"]);
        assert!(clean_options(&opts(&["Ramen", "RAMEN", " "])).is_err(), "one option is no choice");
        let many: Vec<String> = (0..20).map(|n| format!("Dish {n}")).collect();
        assert_eq!(clean_options(&many).unwrap().len(), MAX_OPTIONS);
        assert_eq!(clean_options(&opts(&[&"x".repeat(200), "y"])).unwrap()[0].chars().count(), MAX_OPTION_CHARS);
    }

    #[test]
    fn the_request_is_one_choice_question_over_the_options() {
        let body = request_body("  tired, something warm ", &opts(&["Soup", "Salad", "Pizza"]));
        assert_eq!(body["model"], "jev-latest");
        assert_eq!(body["state"], "What the person feels like right now: tired, something warm");
        let q = &body["questions"]["pick"];
        assert_eq!(q["type"], "choice");
        assert_eq!(q["criteria"]["o1"], "Soup");
        assert_eq!(q["criteria"]["o3"], "Pizza");
        assert_eq!(q["criteria"].as_object().unwrap().len(), 3);
        // No feeling typed: the state says so, rather than being empty.
        assert!(request_body("  ", &opts(&["a", "b"]))["state"].as_str().unwrap().contains("no particular preference"));
    }

    #[test]
    fn the_probabilities_make_a_ranking_in_the_order_of_the_options_given() {
        let response = json!({"model":"jev-1.13.0","answers":{"pick":{
            "type":"choice","choice":"o2","confidence":0.7,
            "probabilities":{"o1":0.1,"o2":0.6,"o3":0.3}}}});
        let d = decision_from_response(&response, &opts(&["Soup", "Salad", "Pizza"])).unwrap();
        assert_eq!(d.ranking.iter().map(|r| r.option.as_str()).collect::<Vec<_>>(), ["Salad", "Pizza", "Soup"]);
        assert_eq!(d.ranking[0].share, 0.6);
        assert_eq!(d.confidence, 0.7);
        // An option JEV left out counts for nothing and goes last; ties keep the typed order.
        let partial = json!({"answers":{"pick":{"probabilities":{"o1":0.5,"o3":0.5}}}});
        let d = decision_from_response(&partial, &opts(&["A", "B", "C"])).unwrap();
        assert_eq!(d.ranking.iter().map(|r| r.option.as_str()).collect::<Vec<_>>(), ["A", "C", "B"]);
    }

    #[test]
    fn an_answer_that_ranks_nothing_is_an_error() {
        assert!(decision_from_response(&json!({}), &opts(&["a", "b"])).is_err());
        assert!(decision_from_response(&json!({"answers":{"pick":{}}}), &opts(&["a", "b"])).is_err());
        assert!(decision_from_response(&json!({"answers":{"pick":{"probabilities":{"zzz":1.0}}}}), &opts(&["a", "b"])).is_err());
        assert!(status_message(401).contains("refused") && status_message(429).contains("too many"));
    }
}
