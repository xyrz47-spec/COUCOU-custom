// The chat, answered by Claude Code itself.
//
// `claude -p` is run once per question, headless, and answers with its own
// sign-in: the plan the user already has, and no API key. Coucou reads no
// credential and makes no network call of its own here.
//
// The session is given as little as the chat needs: it can search the web and
// fetch a page, and nothing else — no file tool, no shell, no MCP server, no
// skill. No settings are read (so no hook fires and the island shows no
// session for it) and nothing is kept on disk: the conversation lives in
// chat.rs like any other provider's, and each question carries the earlier
// turns with it. A dropped file rides along as a content block (claude.rs
// builds it), read by Coucou from its own inbox, not by a tool.
//
// The answer streams: every step goes to the island as `chat-delta`, like a
// local model's (local_chat.rs). Each question is a real request and counts
// against the plan, as one typed in a terminal would.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::chat::{self, Chat, ChatContext, ChatReply, ModelInfo};
use crate::i18n::t;
use crate::island::WINDOW_LABEL;
use crate::{claude, platform};

/// `settings.chatProvider` (core/providers.ts has the same id).
pub const ID: &str = "claude-code";
/// The CLI's own names for the newest model of each family.
pub const DEFAULT_MODEL: &str = "sonnet";
const MODELS: &[(&str, &str)] = &[("opus", "Opus"), ("sonnet", "Sonnet"), ("haiku", "Haiku")];
/// All the session may use, and may use without asking.
const TOOLS: &str = "WebSearch,WebFetch";
/// A search and a few pages can take a while; past this the answer is given up.
const TIMEOUT: Duration = Duration::from_secs(240);

/// The chat turn in flight, so that a chat dropped for a new one ends it
/// (lib.rs, chat_reset) rather than letting it use the plan for nobody.
static RUNNING: Mutex<Option<u32>> = Mutex::new(None);

/// Ends the chat turn in flight, if there is one: its answer is not wanted any more.
pub fn cancel() {
    if let Some(pid) = RUNNING.lock().unwrap().take() {
        kill_tree(pid);
    }
}
/// The island is told about new text at most this often.
const DELTA_INTERVAL: Duration = Duration::from_millis(1000 / 15);
/// One stream-json line we are willing to read.
const MAX_LINE: usize = 8 * 1024 * 1024;
/// The stderr kept for the message shown when claude dies without an answer.
const STDERR_TAIL: usize = 1024;

fn not_installed() -> String {
    t("Claude Code isn't installed on this computer.")
}

/// Where the CLI is, for the settings window; None when it is not installed.
pub fn path() -> Option<String> {
    platform::claude_candidates().into_iter().next().map(|p| p.to_string_lossy().to_string())
}

/// The picker's list. Nothing is asked of anyone: the names are the CLI's own.
pub fn models() -> Result<Vec<ModelInfo>, String> {
    path().ok_or_else(not_installed)?;
    Ok(MODELS.iter().map(|(id, label)| ModelInfo { id: id.to_string(), label: label.to_string() }).collect())
}

/// What may ride `--model`: one of the names above or a full model name;
/// anything else (the settings file can hold any text) is the default.
fn model_arg(model: &str) -> &str {
    let ok = !model.is_empty()
        && model.len() <= 64
        && !model.starts_with('-')
        && model.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_'));
    if ok { model } else { DEFAULT_MODEL }
}

/// How hard the model thinks before it answers, as `--effort` takes it
/// (core/providers.ts lists the same). Anything else — "" included, the
/// settings' way of saying "the CLI's own default" — passes no flag.
const EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];

fn effort_arg(effort: &str) -> Option<&'static str> {
    EFFORTS.iter().copied().find(|level| *level == effort.trim())
}

// ── The question ──────────────────────────────────────────────────────────────

/// Adds text to `content`, into the block before it when that one is text.
fn push_text(content: &mut Vec<Value>, text: &str) {
    if let Some(last) = content.last_mut().and_then(|b| b.get_mut("text")) {
        if let Some(before) = last.as_str() {
            *last = Value::String(format!("{before}\n\n{text}"));
            return;
        }
    }
    content.push(json!({ "type": "text", "text": text }));
}

/// The one line written to claude's stdin: a user message holding the earlier
/// turns, each under the name of who said it, then the new one. A turn's
/// blocks are kept as they are, so a picture sent earlier is still there.
fn input_line(history: &[Value], user: &Value) -> String {
    fn add(content: &mut Vec<Value>, turn: &Value) {
        match turn.get("content") {
            Some(Value::String(text)) => push_text(content, text),
            Some(Value::Array(blocks)) => {
                for block in blocks {
                    match block.get("text").and_then(Value::as_str) {
                        Some(text) if block.get("type").and_then(Value::as_str) == Some("text") => push_text(content, text),
                        _ => content.push(block.clone()),
                    }
                }
            }
            _ => {}
        }
    }
    let mut content = Vec::new();
    if !history.is_empty() {
        push_text(&mut content, "Earlier in this conversation:");
        for turn in history {
            let you = turn.get("role").and_then(Value::as_str) == Some("assistant");
            push_text(&mut content, if you { "You answered:" } else { "The user said:" });
            add(&mut content, turn);
        }
        push_text(&mut content, "The user now says:");
    }
    add(&mut content, user);
    json!({ "type": "user", "message": { "role": "user", "content": content } }).to_string()
}

// ── The answer ────────────────────────────────────────────────────────────────

/// What a line of the stream changed.
#[derive(Debug, PartialEq)]
enum Change {
    Nothing,
    /// More text: shown at the next step the throttle lets through.
    Text,
    /// A search began: said at once, it may last a while.
    Status,
}

/// The answer as it grows, read from claude's stream-json lines.
#[derive(Default)]
struct Answer {
    /// The text of every message of the turn, a blank line between two.
    text: String,
    /// A tool is at work: the island says so under the text so far.
    searching: bool,
    /// The `result` line: the turn's last text, or why there is none.
    outcome: Option<Result<String, String>>,
}

impl Answer {
    fn take(&mut self, message: &Value) -> Change {
        match message.get("type").and_then(Value::as_str) {
            Some("stream_event") => {
                // A sub-agent's words are not the answer.
                if message.get("parent_tool_use_id").is_some_and(|id| !id.is_null()) {
                    return Change::Nothing;
                }
                let Some(event) = message.get("event") else { return Change::Nothing };
                match event.get("type").and_then(Value::as_str) {
                    Some("content_block_start") => {
                        match event.pointer("/content_block/type").and_then(Value::as_str) {
                            Some("tool_use" | "server_tool_use") if !self.searching => {
                                self.searching = true;
                                Change::Status
                            }
                            // What follows a search starts a paragraph of its own.
                            Some("text") => {
                                self.searching = false;
                                if !self.text.is_empty() && !self.text.ends_with("\n\n") {
                                    self.text.push_str("\n\n");
                                }
                                Change::Nothing
                            }
                            _ => Change::Nothing,
                        }
                    }
                    Some("content_block_delta") => match event.pointer("/delta/text").and_then(Value::as_str) {
                        Some(more) if event.pointer("/delta/type").and_then(Value::as_str) == Some("text_delta") => {
                            self.text.push_str(more);
                            Change::Text
                        }
                        _ => Change::Nothing,
                    },
                    _ => Change::Nothing,
                }
            }
            Some("result") => {
                let text = message.get("result").and_then(Value::as_str).unwrap_or("").trim().to_string();
                let failed = message.get("is_error").and_then(Value::as_bool).unwrap_or(false);
                self.outcome = Some(if failed {
                    Err(if text.is_empty() { t("Claude Code ended without an answer.") } else { text })
                } else {
                    Ok(text)
                });
                Change::Nothing
            }
            _ => Change::Nothing,
        }
    }

    /// What the island shows while the answer is on its way.
    fn visible(&self) -> String {
        let text = self.text.trim();
        if !self.searching {
            return text.to_string();
        }
        let status = format!("*{}*", t("Searching the web…"));
        if text.is_empty() { status } else { format!("{text}\n\n{status}") }
    }

    /// The finished answer: everything said, or the result's own text when
    /// nothing streamed (an older CLI).
    fn finish(self) -> Option<Result<String, String>> {
        let said = self.text.trim().to_string();
        Some(match self.outcome? {
            Err(why) => Err(why),
            Ok(last) => {
                let text = if said.is_empty() { last } else { said };
                if text.is_empty() { Err(t("No response text.")) } else { Ok(text) }
            }
        })
    }
}

// ── One turn ──────────────────────────────────────────────────────────────────

/// One chat turn with Claude Code.
pub async fn send(
    app: &AppHandle,
    chat: &Chat,
    model: &str,
    effort: &str,
    query: String,
    context: Option<ChatContext>,
) -> Result<ChatReply, String> {
    let exe = platform::claude_candidates().into_iter().next().ok_or_else(not_installed)?;
    let effort = effort_arg(effort);
    let turn = chat.begin(ID);
    let user = json!({ "role": "user", "content": claude::user_content(turn.first, context.as_ref(), &query) });
    let line = input_line(&turn.history, &user);
    let system = chat::system_prompt(true);
    let model = model_arg(model).to_string();

    let island = app.clone();
    let answer = tauri::async_runtime::spawn_blocking(move || {
        run(&exe, &model, effort, &system, line, |visible| {
            let _ = island.emit_to(WINDOW_LABEL, "chat-delta", visible);
        })
    })
    .await
    .map_err(|e| e.to_string())??;

    let plain = chat::plain_question(turn.first, context.as_ref(), &query);
    chat.commit(&turn, user, json!({ "role": "assistant", "content": answer }), &plain, &answer);
    Ok(ChatReply { text: answer })
}

/// Runs claude on one question and follows its stream to the answer.
/// Blocking: called off the async runtime's own threads.
fn run(
    exe: &Path,
    model: &str,
    effort: Option<&str>,
    system: &str,
    line: String,
    mut on_delta: impl FnMut(String),
) -> Result<String, String> {
    let mut cmd = Command::new(exe);
    cmd.args([
        "-p",
        "--model",
        model,
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--no-session-persistence",
        // Only this folder's own settings, of which there are none: no hook of
        // the user's runs, Coucou's included (claude_plan.rs).
        "--setting-sources",
        "local",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--system-prompt",
        system,
        "--tools",
        TOOLS,
        "--allowedTools",
        TOOLS,
    ]);
    if let Some(level) = effort {
        cmd.args(["--effort", level]);
    }
    cmd.current_dir(platform::local_dir()).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // An npm install is a script calling node: its own folder first on PATH (codex_plan.rs).
    if let Some(parent) = exe.parent() {
        let mut dirs = vec![parent.to_path_buf()];
        if let Some(path) = std::env::var_os("PATH") {
            dirs.extend(std::env::split_paths(&path));
        }
        if let Ok(joined) = std::env::join_paths(dirs) {
            cmd.env("PATH", joined);
        }
    }
    platform::no_console(&mut cmd);
    let mut child = cmd.spawn().map_err(|err| format!("claude: {err}"))?;
    let pid = child.id();
    *RUNNING.lock().unwrap() = Some(pid);

    // The question goes in on its own thread: a picture can be larger than the
    // pipe holds, and claude may not read it all before it starts to write.
    if let Some(mut stdin) = child.stdin.take() {
        std::thread::spawn(move || {
            let _ = stdin.write_all(line.as_bytes());
            let _ = stdin.write_all(b"\n");
        });
    }
    // stderr drained so its pipe can never fill, the tail kept for the message.
    let tail = Arc::new(Mutex::new(Vec::new()));
    if let Some(stderr) = child.stderr.take() {
        let tail = tail.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut buf = [0u8; 1024];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                let mut kept = tail.lock().unwrap();
                kept.extend_from_slice(&buf[..n]);
                let overflow = kept.len().saturating_sub(STDERR_TAIL);
                if overflow > 0 {
                    kept.drain(..overflow);
                }
            }
        });
    }
    // The watchdog ends a turn that outlives any reasonable answer; it leaves
    // as soon as the turn is over (`done` is dropped).
    let timed_out = Arc::new(AtomicBool::new(false));
    let (done, over) = mpsc::channel::<()>();
    {
        let timed_out = timed_out.clone();
        std::thread::spawn(move || {
            if over.recv_timeout(TIMEOUT) == Err(mpsc::RecvTimeoutError::Timeout) {
                timed_out.store(true, Ordering::Release);
                kill_tree(pid);
            }
        });
    }

    let mut answer = Answer::default();
    if let Some(stdout) = child.stdout.take() {
        let mut reader = BufReader::new(stdout);
        let mut line = Vec::new();
        let mut last = Instant::now().checked_sub(DELTA_INTERVAL).unwrap_or_else(Instant::now);
        let mut unsent = false;
        loop {
            line.clear();
            match (&mut reader).take(MAX_LINE as u64 + 1).read_until(b'\n', &mut line) {
                Ok(n) if n > 0 && line.len() <= MAX_LINE => {}
                _ => break,
            }
            let Ok(message) = serde_json::from_slice::<Value>(&line) else { continue };
            let change = answer.take(&message);
            if answer.outcome.is_some() {
                break;
            }
            unsent |= change != Change::Nothing;
            if unsent && (change == Change::Status || last.elapsed() >= DELTA_INTERVAL) {
                last = Instant::now();
                unsent = false;
                on_delta(answer.visible());
            }
        }
    }
    drop(done);
    {
        let mut running = RUNNING.lock().unwrap();
        if *running == Some(pid) {
            *running = None;
        }
    }
    // The answer is in, or it never came: either way the session is done with.
    kill_tree(pid);
    let _ = child.kill();
    let _ = child.wait();

    match answer.finish() {
        Some(outcome) => outcome,
        None if timed_out.load(Ordering::Acquire) => Err(t("Claude Code took too long to answer.")),
        None => {
            let kept = tail.lock().unwrap();
            let tail = String::from_utf8_lossy(&kept).trim().to_string();
            let none = t("Claude Code ended without an answer.");
            Err(if tail.is_empty() { none } else { format!("{none}\n\n{tail}") })
        }
    }
}

// ── A question answered as data ───────────────────────────────────────────────

/// What `ask_json` waits for at most: these are short questions.
const JSON_TIMEOUT: Duration = Duration::from_secs(120);
/// The whole answer of `ask_json` is one JSON object of a few kilobytes.
const MAX_JSON: u64 = 4 * 1024 * 1024;

/// One question to Claude Code, answered as JSON of the shape `schema`
/// describes (`--json-schema`): no tool at all, nothing kept, no settings read
/// — the same closed session as the chat's, without even the web. For Coucou's
/// own features that need a judgement rather than a conversation
/// (skill_advisor.rs). Blocking: call it off the async runtime's own threads.
pub fn ask_json(model: &str, system: &str, prompt: String, schema: &Value) -> Result<Value, String> {
    let exe = platform::claude_candidates().into_iter().next().ok_or_else(not_installed)?;
    let schema = schema.to_string();
    let mut cmd = Command::new(&exe);
    cmd.args([
        "-p",
        "--model",
        model_arg(model),
        "--output-format",
        "json",
        "--json-schema",
        &schema,
        "--no-session-persistence",
        "--setting-sources",
        "local",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--system-prompt",
        system,
        "--tools",
        "",
    ]);
    cmd.current_dir(platform::local_dir()).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    if let Some(parent) = exe.parent() {
        let mut dirs = vec![parent.to_path_buf()];
        if let Some(path) = std::env::var_os("PATH") {
            dirs.extend(std::env::split_paths(&path));
        }
        if let Ok(joined) = std::env::join_paths(dirs) {
            cmd.env("PATH", joined);
        }
    }
    platform::no_console(&mut cmd);
    let mut child = cmd.spawn().map_err(|err| format!("claude: {err}"))?;
    let pid = child.id();
    if let Some(mut stdin) = child.stdin.take() {
        std::thread::spawn(move || {
            let _ = stdin.write_all(prompt.as_bytes());
        });
    }
    let timed_out = Arc::new(AtomicBool::new(false));
    let (done, over) = mpsc::channel::<()>();
    {
        let timed_out = timed_out.clone();
        std::thread::spawn(move || {
            if over.recv_timeout(JSON_TIMEOUT) == Err(mpsc::RecvTimeoutError::Timeout) {
                timed_out.store(true, Ordering::Release);
                kill_tree(pid);
            }
        });
    }
    let mut out = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        let _ = stdout.take(MAX_JSON).read_to_end(&mut out);
    }
    drop(done);
    kill_tree(pid);
    let _ = child.kill();
    let _ = child.wait();
    if timed_out.load(Ordering::Acquire) {
        return Err(t("Claude Code took too long to answer."));
    }
    let answer: Value = serde_json::from_slice(&out).map_err(|_| t("Claude Code ended without an answer."))?;
    structured(&answer)
}

/// The data in what `claude -p --output-format json` printed: the `result`
/// message's `structured_output`, or why there is none.
fn structured(answer: &Value) -> Result<Value, String> {
    // One object; an older CLI prints the whole list of messages.
    let result = match answer {
        Value::Array(messages) => messages.iter().rev().find(|m| m.get("type").and_then(Value::as_str) == Some("result")),
        other => Some(other),
    }
    .ok_or_else(|| t("Claude Code ended without an answer."))?;
    let text = result.get("result").and_then(Value::as_str).unwrap_or("").trim();
    if result.get("is_error").and_then(Value::as_bool).unwrap_or(false) {
        return Err(if text.is_empty() { t("Claude Code ended without an answer.") } else { text.to_string() });
    }
    match result.get("structured_output") {
        Some(data) if data.is_object() => Ok(data.clone()),
        // No field for it (an older CLI): the text is the JSON.
        _ => serde_json::from_str::<Value>(text)
            .ok()
            .filter(Value::is_object)
            .ok_or_else(|| t("Claude Code ended without an answer.")),
    }
}

/// Ends the whole tree: an npm install runs `claude.cmd`, and killing cmd.exe
/// alone would leave node running under it (task_runner.rs does the same).
fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let mut kill = Command::new("taskkill");
        kill.args(["/T", "/F", "/PID", &pid.to_string()]);
        platform::no_console(&mut kill);
        let _ = kill.stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill").args(["-9", &pid.to_string()]).stderr(Stdio::null()).status();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn delta(text: &str) -> Value {
        json!({"type":"stream_event","parent_tool_use_id":null,"event":{"type":"content_block_delta","delta":{"type":"text_delta","text":text}}})
    }

    fn start(kind: &str) -> Value {
        json!({"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":kind}}})
    }

    #[test]
    fn the_first_question_goes_as_it_is() {
        let user = json!({"role":"user","content":[{"type":"text","text":"File: a.png"},{"type":"text","text":"what is it?"}]});
        let line: Value = serde_json::from_str(&input_line(&[], &user)).unwrap();
        assert_eq!(line["type"], "user");
        assert_eq!(line["message"]["role"], "user");
        assert_eq!(line["message"]["content"], json!([{"type":"text","text":"File: a.png\n\nwhat is it?"}]));
    }

    #[test]
    fn later_questions_carry_the_earlier_turns_pictures_included() {
        let picture = json!({"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}});
        let history = vec![
            json!({"role":"user","content":[picture.clone(), {"type":"text","text":"File: a.png"}, {"type":"text","text":"what is it?"}]}),
            json!({"role":"assistant","content":"A red square."}),
            // A turn another provider answered comes back as plain text.
            json!({"role":"user","content":"and now?"}),
            json!({"role":"assistant","content":"Still red."}),
        ];
        let user = json!({"role":"user","content":[{"type":"text","text":"thanks"}]});
        let line: Value = serde_json::from_str(&input_line(&history, &user)).unwrap();
        let content = line["message"]["content"].as_array().unwrap();
        assert_eq!(content.len(), 3);
        assert_eq!(content[0]["text"], "Earlier in this conversation:\n\nThe user said:");
        assert_eq!(content[1], picture);
        assert_eq!(
            content[2]["text"],
            "File: a.png\n\nwhat is it?\n\nYou answered:\n\nA red square.\n\nThe user said:\n\nand now?\n\nYou answered:\n\nStill red.\n\nThe user now says:\n\nthanks"
        );
    }

    #[test]
    fn the_answer_is_every_text_of_the_turn_and_a_search_is_said_while_it_lasts() {
        let mut a = Answer::default();
        assert_eq!(a.take(&json!({"type":"system","subtype":"init"})), Change::Nothing);
        assert_eq!(a.take(&start("thinking")), Change::Nothing);
        assert_eq!(a.take(&json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hm"}}})), Change::Nothing);
        assert_eq!(a.visible(), "");
        a.take(&start("text"));
        assert_eq!(a.take(&delta("Let me ")), Change::Text);
        a.take(&delta("look."));
        assert_eq!(a.take(&start("tool_use")), Change::Status);
        assert_eq!(a.visible(), "Let me look.\n\n*Searching the web…*");
        // A second tool in a row says nothing new.
        assert_eq!(a.take(&start("tool_use")), Change::Nothing);
        a.take(&json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\"query\""}}}));
        a.take(&json!({"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"leak"}]}}));
        a.take(&start("text"));
        a.take(&delta("It is 42."));
        assert_eq!(a.visible(), "Let me look.\n\nIt is 42.");
        // The finished messages repeat what streamed: they are not read twice.
        a.take(&json!({"type":"assistant","message":{"content":[{"type":"text","text":"It is 42."}]}}));
        assert!(a.outcome.is_none());
        a.take(&json!({"type":"result","subtype":"success","is_error":false,"result":"It is 42."}));
        assert_eq!(a.finish(), Some(Ok("Let me look.\n\nIt is 42.".to_string())));
    }

    #[test]
    fn a_search_before_any_text_shows_alone_and_a_sub_agent_is_not_the_answer() {
        let mut a = Answer::default();
        a.take(&start("server_tool_use"));
        assert_eq!(a.visible(), "*Searching the web…*");
        let mut inner = delta("inner words");
        inner["parent_tool_use_id"] = json!("toolu_1");
        assert_eq!(a.take(&inner), Change::Nothing);
        assert_eq!(a.visible(), "*Searching the web…*");
    }

    #[test]
    fn the_result_says_why_there_is_no_answer() {
        let mut a = Answer::default();
        a.take(&json!({"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login"}));
        assert_eq!(a.finish(), Some(Err("Not logged in · Please run /login".to_string())));
        let mut a = Answer::default();
        a.take(&json!({"type":"result","is_error":true}));
        assert_eq!(a.finish(), Some(Err("Claude Code ended without an answer.".to_string())));
        // Nothing streamed (an older CLI): the result's own text is the answer.
        let mut a = Answer::default();
        a.take(&json!({"type":"result","is_error":false,"result":" Hello. "}));
        assert_eq!(a.finish(), Some(Ok("Hello.".to_string())));
        let mut a = Answer::default();
        a.take(&json!({"type":"result","is_error":false,"result":""}));
        assert_eq!(a.finish(), Some(Err("No response text.".to_string())));
        // The stream ended before any result.
        assert_eq!(Answer::default().finish(), None);
    }

    #[test]
    fn only_a_model_name_may_ride_the_command_line() {
        assert_eq!(model_arg("opus"), "opus");
        assert_eq!(model_arg("claude-sonnet-5-5"), "claude-sonnet-5-5");
        assert_eq!(model_arg(""), DEFAULT_MODEL);
        assert_eq!(model_arg("--dangerously-skip-permissions"), DEFAULT_MODEL);
        assert_eq!(model_arg("opus --tools default"), DEFAULT_MODEL);
        assert_eq!(model_arg(&"a".repeat(65)), DEFAULT_MODEL);
        assert!(MODELS.iter().any(|(id, _)| *id == DEFAULT_MODEL));
    }

    #[test]
    fn the_data_is_read_from_the_result_or_its_error_said() {
        let ok = json!({"type":"result","is_error":false,"result":"{\"queries\":[\"a\"]}","structured_output":{"queries":["a"]}});
        assert_eq!(structured(&ok).unwrap(), json!({"queries":["a"]}));
        // An older CLI: a list of messages, and the JSON only as text.
        let list = json!([{"type":"system"},{"type":"result","is_error":false,"result":" {\"n\":1} "}]);
        assert_eq!(structured(&list).unwrap(), json!({"n":1}));
        let failed = json!({"type":"result","is_error":true,"result":"Not logged in · Please run /login"});
        assert_eq!(structured(&failed).unwrap_err(), "Not logged in · Please run /login");
        let prose = json!({"type":"result","is_error":false,"result":"Sure! Here you go."});
        assert_eq!(structured(&prose).unwrap_err(), "Claude Code ended without an answer.");
        assert!(structured(&json!([{"type":"system"}])).is_err());
    }

    #[test]
    fn only_a_known_effort_becomes_a_flag() {
        assert_eq!(effort_arg("high"), Some("high"));
        assert_eq!(effort_arg(" max "), Some("max"));
        assert_eq!(effort_arg("xhigh"), Some("xhigh"));
        // "" is the CLI's own default: no flag.
        assert_eq!(effort_arg(""), None);
        assert_eq!(effort_arg("High"), None);
        assert_eq!(effort_arg("--tools default"), None);
    }

    /// The real CLI, with the user's own sign-in: one small question. Run by
    /// hand (`cargo test live_claude -- --ignored --nocapture`); it counts
    /// against the plan like any question.
    #[test]
    #[ignore]
    fn live_claude_answers_and_streams() {
        let exe = platform::claude_candidates().into_iter().next().expect("claude is installed");
        let user = json!({"role":"user","content":[{"type":"text","text":"Reply with the single word: pong"}]});
        let mut steps = Vec::new();
        let answer =
            run(&exe, "haiku", effort_arg("low"), "You answer in one word.", input_line(&[], &user), |v| steps.push(v)).unwrap();
        println!("answer: {answer:?}, steps: {steps:?}");
        assert!(answer.to_lowercase().contains("pong"), "{answer}");
        assert!(!steps.is_empty());
    }
}
