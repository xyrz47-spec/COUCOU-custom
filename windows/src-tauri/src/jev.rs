// JEV (TypeSafe's System One model): a quick read of a message.
//
// The Check tab takes a message — one received, or one about to be sent — and
// asks JEV four typed questions about it in one call: how it sounds (friendly,
// neutral, formal, stern, upset), how urgent it is, whether it asks for an
// answer, and whether it could come across as rude. JEV does not write text; it
// answers with values the tab can show at a glance.
//
// It needs a TypeSafe API key (Settings → JEV, kept in the credential store,
// never on disk). Without one, or with the feature off, nothing is sent. What
// is sent is the text the user pasted, cut at MAX_SENT characters — nothing
// else — and only when they press Check.
//
// The API: POST https://api.typesafe.ai/v1/systemone with a Bearer key, a
// `state` and typed `questions` (docs.typesafe.ai).

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
/// Most characters of a message sent.
pub const MAX_SENT: usize = 3000;
/// How the message may sound, as the tone question names them.
pub const TONES: &[&str] = &["friendly", "neutral", "formal", "stern", "upset"];

pub fn request_body(text: &str) -> Value {
    let message: String = text.trim().chars().take(MAX_SENT).collect();
    json!({
        "state": format!("A message:\n{message}"),
        "model": MODEL,
        "questions": {
            "tone": {
                "type": "choice",
                "instructions": "How the message sounds",
                "criteria": {
                    "friendly": "Warm, kind or cheerful",
                    "neutral": "Plain and matter-of-fact",
                    "formal": "Polite and businesslike",
                    "stern": "Firm, curt or demanding",
                    "upset": "Angry, annoyed or hurt"
                }
            },
            "urgency": {
                "type": "score",
                "instructions": "How urgent the message is for the reader",
                "criteria": ["Not urgent, no deadline", "Should be answered soon", "Urgent, needs attention right now"]
            },
            "needs_reply": {
                "type": "noul",
                "instructions": "The message asks for an answer or an action from the reader."
            },
            "rude": {
                "type": "noul",
                "instructions": "The message could come across as rude or hurtful."
            }
        }
    })
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRead {
    /// One of TONES; empty when JEV did not say.
    pub tone: String,
    pub tone_confidence: f64,
    /// 0 (not urgent) to 2 (urgent now), in between when unsure.
    pub urgency: f64,
    pub urgency_confidence: f64,
    /// 0 to 1: how likely the message asks for an answer.
    pub needs_reply: f64,
    /// 0 to 1: how likely it could sound rude.
    pub rude: f64,
}

fn number(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64).filter(|n| n.is_finite())
}

/// The read in a /v1/systemone response, or why it is not usable.
pub fn read_from_response(response: &Value) -> Result<MessageRead, String> {
    let answers = response.get("answers").ok_or("the answer holds no answers")?;
    let get = |name: &str| answers.get(name).ok_or_else(|| format!("the answer holds no \"{name}\""));
    let tone = get("tone")?;
    let urgency = get("urgency")?;
    let choice = tone.get("choice").and_then(Value::as_str).unwrap_or("");
    Ok(MessageRead {
        tone: if TONES.contains(&choice) { choice.to_string() } else { String::new() },
        tone_confidence: number(tone, "confidence").unwrap_or(0.0).clamp(0.0, 1.0),
        urgency: number(urgency, "score").ok_or("\"urgency\" has no score")?.clamp(0.0, 2.0),
        urgency_confidence: number(urgency, "confidence").unwrap_or(0.0).clamp(0.0, 1.0),
        needs_reply: number(get("needs_reply")?, "noul").ok_or("\"needs_reply\" has no value")?.clamp(0.0, 1.0),
        rude: number(get("rude")?, "noul").ok_or("\"rude\" has no value")?.clamp(0.0, 1.0),
    })
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

/// How a message sounds. Asked only when the user presses Check, with the saved key.
#[tauri::command]
pub async fn jev_check_message(shared: State<'_, Shared>, text: String) -> Result<MessageRead, String> {
    if text.trim().is_empty() {
        return Err("Paste a message first.".into());
    }
    if !crate::features::on(&shared.settings.lock().unwrap(), "messageCheck") {
        return Err("The message check is off in Settings → Features.".into());
    }
    let key = secrets::get(KEY).ok_or("No TypeSafe API key: add one in Settings → JEV.")?;
    read_from_response(&call(&key, &request_body(&text)).await?)
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

    #[test]
    fn the_request_asks_four_typed_questions_about_the_message_cut_short() {
        let body = request_body(&format!("  Hi  {}", "a".repeat(5000)));
        assert_eq!(body["model"], "jev-latest");
        let state = body["state"].as_str().unwrap();
        assert!(state.starts_with("A message:\nHi"));
        assert!(state.chars().count() <= MAX_SENT + 20);
        let q = &body["questions"];
        assert_eq!((q["tone"]["type"].as_str(), q["urgency"]["type"].as_str()), (Some("choice"), Some("score")));
        assert_eq!((q["needs_reply"]["type"].as_str(), q["rude"]["type"].as_str()), (Some("noul"), Some("noul")));
        let tones: Vec<_> = q["tone"]["criteria"].as_object().unwrap().keys().map(String::as_str).collect();
        for tone in TONES {
            assert!(tones.contains(tone), "{tone}");
        }
        assert_eq!(q["urgency"]["criteria"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn a_response_becomes_a_read() {
        let response = json!({"model":"jev-1.13.0","answers":{
            "tone":{"type":"choice","choice":"stern","confidence":0.8,"probabilities":{"stern":0.9}},
            "urgency":{"type":"score","score":1.0,"confidence":1.0,"legend":{},"probabilities":{}},
            "needs_reply":{"type":"noul","noul":1.0},
            "rude":{"type":"noul","noul":0.25}}});
        let read = read_from_response(&response).unwrap();
        assert_eq!(read.tone, "stern");
        assert_eq!((read.tone_confidence, read.urgency, read.urgency_confidence), (0.8, 1.0, 1.0));
        assert_eq!((read.needs_reply, read.rude), (1.0, 0.25));
    }

    #[test]
    fn a_response_that_is_not_what_was_asked_is_an_error_and_odd_values_are_dropped() {
        assert!(read_from_response(&json!({})).is_err());
        assert!(read_from_response(&json!({"answers":{"tone":{"choice":"stern"}}})).is_err());
        let odd = json!({"answers":{
            "tone":{"choice":"sarcastic","confidence":7.0},
            "urgency":{"score":9.0,"confidence":0.5},
            "needs_reply":{"noul":3.0},"rude":{"noul":-1.0}}});
        let read = read_from_response(&odd).unwrap();
        assert_eq!(read.tone, "", "a tone that was not offered is dropped");
        assert_eq!((read.tone_confidence, read.urgency, read.needs_reply, read.rude), (1.0, 2.0, 1.0, 0.0), "kept in range");
        assert!(status_message(401).contains("refused") && status_message(429).contains("too many"));
    }
}
