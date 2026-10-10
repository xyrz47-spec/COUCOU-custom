// Claude plan usage, asked of the Claude Code CLI itself.
//
// The numbers normally come from Claude Code's status line, through the relay
// (hook/src/statusline.rs). A status line only exists in a terminal session:
// Claude Code started from the Claude desktop app has none, so somebody who
// only works there never got a number. This asks instead, the way
// codex_plan.rs asks Codex: `claude -p` is run once, headless, and the plan
// limits are read from the `rate_limit_event` it prints with its answer.
//
// Coucou makes no network call of its own and reads no credential: Claude Code
// answers with its own sign-in. The question is as small as one can be — the
// smallest model, no tools, a system prompt of three words, no settings read
// (so no hook fires and the island shows no session), nothing kept on disk —
// but it is a real request and counts as one against the plan. So it runs only
// when the pill shows or is clicked and the numbers are old, at most once at a
// time, for 45 s at most, and is skipped while Coucou is paused.

use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::atomic::{self, AtomicBool};
use std::sync::mpsc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::platform;

const TIMEOUT: Duration = Duration::from_secs(45);
/// Lines read before giving up: the event comes within the first handful.
const MAX_LINES: usize = 400;

static BUSY: AtomicBool = AtomicBool::new(false);

struct NotBusy;
impl Drop for NotBusy {
    fn drop(&mut self) {
        BUSY.store(false, atomic::Ordering::Release);
    }
}

/// The plan limits in the shape the status line gives them (`rate_limits`), or
/// `None` when Claude Code is not installed, not signed in to a plan, slow,
/// already being asked, or Coucou is paused. Blocking: call it off the main thread.
pub fn read() -> Option<Value> {
    if crate::integrations::PAUSED.load(atomic::Ordering::Relaxed) {
        return None;
    }
    if BUSY.swap(true, atomic::Ordering::AcqRel) {
        return None;
    }
    let _busy = NotBusy;

    let exe = platform::claude_candidates().into_iter().next()?;
    let dir = platform::local_dir();
    let mut cmd = Command::new(&exe);
    cmd.args([
        "-p",
        "ok",
        "--model",
        "haiku",
        "--output-format",
        "stream-json",
        "--verbose",
        "--no-session-persistence",
        // Only this folder's own settings, of which there are none: no hook of
        // the user's runs, Coucou's included.
        "--setting-sources",
        "local",
        "--system-prompt",
        "Reply with ok.",
        "--tools",
        "",
    ]);
    cmd.current_dir(&dir).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
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
    let mut child = cmd.spawn().ok()?;

    let limits = child.stdout.take().and_then(|stdout| {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(first_limits(BufReader::new(stdout)));
        });
        rx.recv_timeout(TIMEOUT).ok().flatten()
    });
    // The answer is in, or it never came: either way the session is done with.
    #[cfg(windows)]
    {
        let mut kill = Command::new("taskkill");
        kill.args(["/T", "/F", "/PID", &child.id().to_string()]);
        platform::no_console(&mut kill);
        let _ = kill.status();
    }
    let _ = child.kill();
    let _ = child.wait();
    crate::log::line(if limits.is_some() { "plan usage: asked claude" } else { "plan usage: claude gave no limits" });
    limits.map(|rate_limits| json!({ "rate_limits": rate_limits }))
}

/// Reads stream-json lines until the `rate_limit_event` and returns its windows
/// as the status line's `rate_limits`.
pub fn first_limits(reader: impl BufRead) -> Option<Value> {
    for line in reader.lines().take(MAX_LINES).map_while(Result::ok) {
        let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
        if message.get("type").and_then(Value::as_str) != Some("rate_limit_event") {
            continue;
        }
        if let Some(limits) = message.pointer("/rate_limit_info/unifiedWindows").and_then(as_rate_limits) {
            return Some(limits);
        }
    }
    None
}

/// `{ five_hour: { utilization: 0.41, resetsAt }, … }` → the status line's
/// `{ five_hour: { used_percentage: 41, resets_at }, … }`, which the page
/// already reads (core/plan.ts, parseClaudePlan). A window without both numbers
/// is left out; none at all is nothing.
fn as_rate_limits(windows: &Value) -> Option<Value> {
    let mut out = serde_json::Map::new();
    for key in ["five_hour", "seven_day"] {
        let Some(window) = windows.get(key) else { continue };
        let (Some(used), Some(resets)) = (
            window.get("utilization").and_then(Value::as_f64),
            window.get("resetsAt").and_then(Value::as_f64),
        ) else {
            continue;
        };
        out.insert(key.into(), json!({ "used_percentage": used * 100.0, "resets_at": resets }));
    }
    (!out.is_empty()).then_some(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_limits_are_read_from_the_rate_limit_event() {
        let stream = concat!(
            r#"{"type":"system","subtype":"init","tools":[]}"#, "\n",
            "not json\n",
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}"#, "\n",
            r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","rateLimitType":"five_hour","unifiedWindows":{"five_hour":{"utilization":0.41,"resetsAt":1791664200},"seven_day":{"utilization":0.63,"resetsAt":1791885600}}}}"#, "\n",
            r#"{"type":"result","subtype":"success"}"#, "\n",
        );
        let limits = first_limits(stream.as_bytes()).unwrap();
        assert_eq!(limits["five_hour"]["used_percentage"], 41.0);
        assert_eq!(limits["five_hour"]["resets_at"], 1791664200.0);
        assert_eq!(limits["seven_day"]["used_percentage"], 63.0);
    }

    #[test]
    fn no_event_or_no_usable_window_is_nothing() {
        // An API key has no plan: the stream ends without the event.
        assert!(first_limits(r#"{"type":"result","subtype":"success"}"#.as_bytes()).is_none());
        let empty = r#"{"type":"rate_limit_event","rate_limit_info":{"unifiedWindows":{"five_hour":{"utilization":"x"}}}}"#;
        assert!(first_limits(empty.as_bytes()).is_none());
        // One window is enough.
        let week = r#"{"type":"rate_limit_event","rate_limit_info":{"unifiedWindows":{"seven_day":{"utilization":0.5,"resetsAt":1791885600}}}}"#;
        let limits = first_limits(week.as_bytes()).unwrap();
        assert!(limits.get("five_hour").is_none());
        assert_eq!(limits["seven_day"]["used_percentage"], 50.0);
    }
}
