// JEV (TypeSafe's System One model): a second opinion on a permission request.
//
// When Claude Code, Codex or another agent asks permission, the card shows what
// is being asked. With a TypeSafe API key and Settings → Features → "Risk check
// by JEV" on, the island also asks JEV four typed questions about that request
// — does it delete or overwrite things, does it send data away or reveal
// secrets, what does it mainly do, how risky is it to allow unread — and the
// card gets one line: routine, worth reading, or could change or send things.
//
// It is advice and nothing else. It never allows or denies, never waits for
// the answer (a slow or failed call just leaves the card as it was), and the
// two buttons stay the only way to decide. No key, no call: nothing leaves this
// PC until the user has put a key in Settings → JEV.
//
// What is sent: the tool's name and the line the card shows (the command, the
// file path or the address), with anything that looks like a secret masked and
// cut at MAX_SENT characters. No file contents, no project path, no prompt.
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
const TIMEOUT: Duration = Duration::from_secs(6);
/// Most characters of the request sent.
const MAX_SENT: usize = 1500;

/// Words in a `name=value` that make the value a secret.
const SECRET_NAMES: &[&str] = &["token", "secret", "password", "passwd", "apikey", "api_key", "api-key", "authorization", "bearer", "credential"];
/// Starts of the keys and tokens services hand out.
const SECRET_PREFIXES: &[&str] = &["sk-", "ghp_", "gho_", "github_pat_", "xoxb-", "xoxp-", "akia", "eyj", "glpat-", "npm_", "pk_live", "sk_live"];

fn looks_like_token(word: &str) -> bool {
    let w = word.trim_matches(|c: char| !c.is_ascii_alphanumeric());
    let lower = w.to_ascii_lowercase();
    SECRET_PREFIXES.iter().any(|p| lower.starts_with(p) && w.len() >= 12)
        || (w.len() >= 32 && w.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') && w.chars().any(|c| c.is_ascii_digit()))
}

/// `text` with secrets masked: values of `name=value` where the name says secret, a word after
/// `Bearer`/`Authorization:`, and words that look like an API key or token.
pub fn redact(text: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut mask_next = false;
    let mut words = text.split_whitespace().peekable();
    while let Some(word) = words.next() {
        let lower = word.to_ascii_lowercase();
        if mask_next {
            out.push("[hidden]".into());
            mask_next = false;
            continue;
        }
        if let Some((name, _value)) = word.split_once(['=', ':']).filter(|(n, v)| !n.is_empty() && !v.is_empty()) {
            let name_lower = name.to_ascii_lowercase();
            if SECRET_NAMES.iter().any(|s| name_lower.contains(s)) {
                out.push(format!("{name}=[hidden]"));
                continue;
            }
        }
        if SECRET_NAMES.iter().any(|s| lower.trim_end_matches([':', '=']) == *s) && (lower.ends_with(':') || lower.ends_with('=') || lower == "bearer") {
            out.push(word.to_string());
            // "Authorization: Bearer <token>": the scheme stays, the token after it goes.
            let scheme_follows = words.peek().is_some_and(|w| matches!(w.to_ascii_lowercase().as_str(), "bearer" | "basic"));
            mask_next = !scheme_follows;
            continue;
        }
        out.push(if looks_like_token(word) { "[hidden]".into() } else { word.to_string() });
    }
    out.join(" ")
}

/// The state JEV reads.
pub fn state_for(tool: &str, command: &str) -> String {
    let tool: String = tool.trim().chars().take(60).collect();
    let action: String = redact(command).chars().take(MAX_SENT).collect();
    format!("An AI coding agent asks permission to use a tool.\nTool: {tool}\nAction: {action}")
}

pub fn request_body(tool: &str, command: &str) -> Value {
    json!({
        "state": state_for(tool, command),
        "model": MODEL,
        "questions": {
            "destructive": {
                "type": "noul",
                "instructions": "The action deletes, overwrites or irreversibly changes files, data, repositories or system settings."
            },
            "exfiltration": {
                "type": "noul",
                "instructions": "The action sends data to another machine, or reveals credentials, tokens or private files."
            },
            "scope": {
                "type": "choice",
                "instructions": "What the action mainly does",
                "criteria": {
                    "read_only": "Only reads or lists things",
                    "edit_files": "Creates or edits files in the project",
                    "run_code": "Installs or runs programs or scripts",
                    "network": "Talks to the network or another machine",
                    "system": "Changes the system, permissions or settings outside the project"
                }
            },
            "risk": {
                "type": "score",
                "instructions": "How risky it is to allow this without reading it carefully",
                "criteria": [
                    "Routine and harmless",
                    "Normal for coding but changes things",
                    "Could cause real harm if it was not intended"
                ]
            }
        }
    })
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Risk {
    /// "low", "medium", "high" or "unsure".
    pub level: &'static str,
    pub destructive: f64,
    pub exfiltration: f64,
    /// read_only, edit_files, run_code, network or system; empty when JEV did not say.
    pub scope: String,
    pub score: f64,
    pub confidence: f64,
}

fn number(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64).filter(|n| n.is_finite())
}

/// The risk the four answers add up to. Pure, so the thresholds can be tested.
pub fn classify(destructive: f64, exfiltration: f64, score: f64, confidence: f64, scope: &str) -> Risk {
    let top = destructive.max(exfiltration);
    let level = if top >= 0.7 || (score >= 1.5 && confidence >= 0.5) {
        "high"
    } else if top >= 0.4 || score >= 0.75 {
        "medium"
    } else if confidence < 0.4 {
        "unsure"
    } else {
        "low"
    };
    Risk { level, destructive, exfiltration, scope: scope.to_string(), score, confidence }
}

/// The risk in a /v1/systemone response, or why it is not usable.
pub fn risk_from_response(response: &Value) -> Result<Risk, String> {
    let answers = response.get("answers").ok_or("the answer holds no answers")?;
    let get = |name: &str| answers.get(name).ok_or_else(|| format!("the answer holds no \"{name}\""));
    let destructive = number(get("destructive")?, "noul").ok_or("\"destructive\" has no value")?;
    let exfiltration = number(get("exfiltration")?, "noul").ok_or("\"exfiltration\" has no value")?;
    let risk = get("risk")?;
    let score = number(risk, "score").ok_or("\"risk\" has no score")?;
    let confidence = number(risk, "confidence").unwrap_or(0.0);
    let scope = get("scope").ok().and_then(|s| s.get("choice")).and_then(Value::as_str).unwrap_or("");
    let scope = if ["read_only", "edit_files", "run_code", "network", "system"].contains(&scope) { scope } else { "" };
    Ok(classify(destructive, exfiltration, score, confidence, scope))
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

/// The risk JEV sees in a permission request. `Err` leaves the card as it was; "off" says nothing is asked.
#[tauri::command]
pub async fn jev_assess(shared: State<'_, Shared>, tool: String, command: String) -> Result<Risk, String> {
    if !crate::features::on(&shared.settings.lock().unwrap(), "approvalRisk") {
        return Err("off".into());
    }
    let key = secrets::get(KEY).ok_or("off")?;
    risk_from_response(&call(&key, &request_body(&tool, &command)).await?)
}

/// Asks JEV one harmless question with the saved key, to say whether the key works.
#[tauri::command]
pub async fn jev_check_key() -> Result<String, String> {
    let key = secrets::get(KEY).ok_or("No API key saved.")?;
    let body = json!({
        "state": "ls -la",
        "model": MODEL,
        "questions": { "destructive": { "type": "noul", "instructions": "The action deletes or overwrites files." } }
    });
    let response = call(&key, &body).await?;
    Ok(response.get("model").and_then(Value::as_str).unwrap_or(MODEL).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_are_masked_before_anything_is_sent() {
        let masked = redact("curl -H Authorization: Bearer abc123def456ghi789 https://x.io --data token=hunter2 && echo ok");
        assert!(!masked.contains("abc123") && !masked.contains("hunter2"), "{masked}");
        assert!(masked.contains("curl") && masked.contains("https://x.io") && masked.contains("echo ok"));
        assert!(redact("export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwx").contains("GITHUB_TOKEN=[hidden]"));
        assert!(!redact("use sk-ant-api03-abcdefghijklmnop now").contains("abcdefgh"));
        assert!(!redact("key 0123456789abcdef0123456789abcdef01").contains("0123456789abcdef"));
        // An ordinary command is left alone.
        assert_eq!(redact("rm -rf ./build && npm run build"), "rm -rf ./build && npm run build");
        assert_eq!(redact("git commit -m \"fix the token refresh\""), "git commit -m \"fix the token refresh\"");
    }

    #[test]
    fn the_state_holds_the_tool_and_the_action_cut_short() {
        let state = state_for("Bash", &format!("echo {}", "a ".repeat(2000)));
        assert!(state.starts_with("An AI coding agent asks permission") && state.contains("Tool: Bash\nAction: echo"));
        assert!(state.chars().count() < MAX_SENT + 200);
    }

    #[test]
    fn the_request_asks_four_typed_questions_of_jev() {
        let body = request_body("Bash", "ls");
        assert_eq!(body["model"], "jev-latest");
        let q = &body["questions"];
        assert_eq!(q["destructive"]["type"], "noul");
        assert_eq!(q["exfiltration"]["type"], "noul");
        assert_eq!(q["scope"]["type"], "choice");
        assert!(q["scope"]["criteria"].as_object().unwrap().len() == 5);
        assert_eq!(q["risk"]["type"], "score");
        assert_eq!(q["risk"]["criteria"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn a_response_becomes_a_level() {
        let response = |d: f64, e: f64, s: f64, c: f64| {
            json!({"model":"jev-1.13.0","answers":{
                "destructive":{"type":"noul","noul":d},"exfiltration":{"type":"noul","noul":e},
                "scope":{"type":"choice","choice":"system","confidence":0.9,"probabilities":{}},
                "risk":{"type":"score","score":s,"confidence":c,"legend":{},"probabilities":{}}}})
        };
        let level = |d, e, s, c| risk_from_response(&response(d, e, s, c)).unwrap().level;
        assert_eq!(level(0.0, 0.0, 0.0, 0.9), "low");
        assert_eq!(level(0.5, 0.0, 0.0, 0.9), "medium");
        assert_eq!(level(0.0, 0.0, 1.0, 0.9), "medium");
        assert_eq!(level(0.9, 0.0, 0.0, 0.9), "high");
        assert_eq!(level(0.0, 0.8, 0.0, 0.9), "high");
        assert_eq!(level(0.0, 0.0, 2.0, 0.8), "high");
        assert_eq!(level(0.0, 0.0, 2.0, 0.2), "medium", "a score JEV is unsure of does not make it high");
        assert_eq!(level(0.0, 0.0, 0.0, 0.2), "unsure");
        assert_eq!(risk_from_response(&response(0.0, 0.0, 0.0, 0.9)).unwrap().scope, "system");
    }

    #[test]
    fn a_response_that_is_not_what_was_asked_is_an_error_not_a_level() {
        assert!(risk_from_response(&json!({})).is_err());
        assert!(risk_from_response(&json!({"answers":{"destructive":{"noul":0.1}}})).is_err());
        let odd_scope = json!({"answers":{"destructive":{"noul":0.0},"exfiltration":{"noul":0.0},
            "scope":{"choice":"teleport"},"risk":{"score":0.0,"confidence":0.9}}});
        assert_eq!(risk_from_response(&odd_scope).unwrap().scope, "", "an unknown scope is dropped");
        assert!(status_message(401).contains("refused") && status_message(429).contains("too many"));
    }
}
