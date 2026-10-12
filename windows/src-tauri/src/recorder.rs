// Recording the VALORANT window while the game runs.
//
// Off until the user turns it on (Settings → Valorant). While it is on, a
// watcher looks every few seconds for the game's own window. When it appears,
// ffmpeg is started to capture that window alone (gdigrab with the window's
// title: nothing else on the screen, not the desktop, not other apps). When the
// window goes, ffmpeg is asked to finish.
//
// What it does not do: read the game's memory, press a key, or tell a match
// from the lobby — the window is the same, so a recording runs from the game's
// start to its end. Finding where a match begins and ends in a recording is
// separate work.
//
// Safety: the file is a fragmented MP4, so a crash or a power cut leaves a
// playable file up to the last fragment. A recording stops after MAX_SECS, and
// does not start (or stops) when the drive is short of space. ffmpeg is not
// bundled: it is looked for on PATH, and the status says when it is missing.
// Recordings stay in platform::local_dir()/valorant/recordings; the user can
// delete them from the Valorant tab.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::{platform, Shared};

/// The game's window title (case and surrounding spaces aside).
const GAME_TITLE: &str = "VALORANT";
const POLL: Duration = Duration::from_secs(3);
/// Longest single recording: about two matches with a lobby between.
pub const MAX_SECS: u64 = 90 * 60;
/// Does not start below this much free space, and stops below the lower one.
pub const MIN_START_BYTES: u64 = 2 << 30;
pub const MIN_KEEP_BYTES: u64 = 500 << 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    /// The setting is off.
    Off,
    /// On, waiting for the game's window.
    Waiting,
    Recording,
    /// On, but ffmpeg was not found on PATH.
    NoFfmpeg,
    /// On, but the drive is short of space.
    LowDisk,
    /// ffmpeg could not capture the window (see `detail`).
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub state: State,
    /// The file being written, or the last one.
    pub file: String,
    pub detail: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Nothing,
    Start,
    Stop,
}

/// What the watcher does next. Pure, so every case can be tested.
pub fn decide(enabled: bool, window: bool, recording: bool, free: Option<u64>, over_time: bool) -> Action {
    if recording {
        let low = free.is_some_and(|f| f < MIN_KEEP_BYTES);
        return if !enabled || !window || low || over_time { Action::Stop } else { Action::Nothing };
    }
    let room = free.is_none_or(|f| f >= MIN_START_BYTES);
    if enabled && window && room { Action::Start } else { Action::Nothing }
}

/// ffmpeg's arguments to capture the window titled `title` into `out`.
pub fn ffmpeg_args(title: &str, out: &Path) -> Vec<String> {
    let mut args: Vec<String> = [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "gdigrab", "-framerate", "30", "-draw_mouse", "0", "-i",
    ]
    .iter()
    .map(|a| a.to_string())
    .collect();
    args.push(format!("title={title}"));
    for a in [
        "-t", &MAX_SECS.to_string(),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p",
        // Playable up to the last fragment, whatever happens to the process.
        "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
    ] {
        args.push(a.to_string());
    }
    args.push(out.to_string_lossy().into_owned());
    args
}

/// `match-<unix seconds>.mp4`
pub fn file_name(now_secs: u64) -> String {
    format!("match-{now_secs}.mp4")
}

pub fn dir() -> PathBuf {
    platform::local_dir().join("valorant").join("recordings")
}

struct Running {
    child: Child,
    since: Instant,
    file: PathBuf,
}

static RUNNING: Mutex<Option<Running>> = Mutex::new(None);
static STATUS: Mutex<Status> = Mutex::new(Status { state: State::Off, file: String::new(), detail: String::new() });

fn set_status(app: &AppHandle, state: State, file: &str, detail: &str) {
    let mut status = STATUS.lock().unwrap();
    if status.state == state && status.file == file && status.detail == detail {
        return;
    }
    *status = Status { state, file: file.to_string(), detail: detail.to_string() };
    let _ = app.emit("valorant-recorder", status.clone());
}

/// Asks ffmpeg to finish (q on its input), and kills it if it does not.
fn finish(mut running: Running) {
    if let Some(stdin) = running.child.stdin.as_mut() {
        let _ = stdin.write_all(b"q");
        let _ = stdin.flush();
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if matches!(running.child.try_wait(), Ok(Some(_))) {
            return;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    let _ = running.child.kill();
    let _ = running.child.wait();
}

fn tick(app: &AppHandle) {
    let enabled = app.state::<Shared>().settings.lock().unwrap().valorant_record;
    let mut slot = RUNNING.lock().unwrap();

    // ffmpeg ended by itself (the window closed under it, an error, MAX_SECS)?
    if let Some(running) = slot.as_mut() {
        if let Ok(Some(code)) = running.child.try_wait() {
            let file = running.file.to_string_lossy().into_owned();
            *slot = None;
            if code.success() {
                set_status(app, State::Waiting, &file, "");
            } else {
                set_status(app, State::Failed, &file, "ffmpeg stopped: is the game in windowed or borderless mode?");
            }
        }
    }

    let window = if enabled { platform::window_titled(GAME_TITLE) } else { None };
    let free = platform::free_disk_bytes(&dir().ancestors().find(|p| p.exists()).map(Path::to_path_buf).unwrap_or_else(platform::local_dir));
    let over = slot.as_ref().is_some_and(|r| r.since.elapsed().as_secs() >= MAX_SECS);

    match decide(enabled, window.is_some(), slot.is_some(), free, over) {
        Action::Stop => {
            if let Some(running) = slot.take() {
                let file = running.file.to_string_lossy().into_owned();
                drop(slot);
                finish(running);
                let low = free.is_some_and(|f| f < MIN_KEEP_BYTES);
                if enabled && low {
                    set_status(app, State::LowDisk, &file, "Stopped: the drive is nearly full.");
                } else if enabled {
                    set_status(app, State::Waiting, &file, "");
                } else {
                    set_status(app, State::Off, &file, "");
                }
            }
        }
        Action::Start => {
            let Some(ffmpeg) = platform::find_on_path("ffmpeg") else {
                set_status(app, State::NoFfmpeg, "", "");
                return;
            };
            let Some(title) = window else { return };
            let _ = fs::create_dir_all(dir());
            let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            let file = dir().join(file_name(now));
            let mut cmd = std::process::Command::new(ffmpeg);
            cmd.args(ffmpeg_args(&title, &file)).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null());
            platform::no_console(&mut cmd);
            match cmd.spawn() {
                Ok(child) => {
                    crate::log::line(format!("recording started: {}", file.display()));
                    set_status(app, State::Recording, &file.to_string_lossy(), "");
                    *slot = Some(Running { child, since: Instant::now(), file });
                }
                Err(err) => set_status(app, State::Failed, "", &err.to_string()),
            }
        }
        Action::Nothing => {
            if slot.is_none() {
                let state = if !enabled {
                    State::Off
                } else if free.is_some_and(|f| f < MIN_START_BYTES) {
                    State::LowDisk
                } else if platform::find_on_path("ffmpeg").is_none() {
                    State::NoFfmpeg
                } else {
                    State::Waiting
                };
                let keep = STATUS.lock().unwrap().clone();
                // A failure stays visible until the game's window comes back.
                if keep.state == State::Failed && state == State::Waiting && window.is_none() {
                    return;
                }
                set_status(app, state, &keep.file, "");
            }
        }
    }
}

/// Starts the watcher. It does nothing but a window lookup every few seconds,
/// and not even that while the setting is off.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || loop {
        tick(&app);
        let idle = !app.state::<Shared>().settings.lock().unwrap().valorant_record && RUNNING.lock().unwrap().is_none();
        std::thread::sleep(if idle { POLL * 3 } else { POLL });
    });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recording {
    pub name: String,
    pub bytes: u64,
    pub modified: u64,
}

#[tauri::command]
pub fn valorant_recorder_status() -> Status {
    STATUS.lock().unwrap().clone()
}

fn is_recording_name(name: &str) -> bool {
    name.strip_prefix("match-")
        .and_then(|rest| rest.strip_suffix(".mp4"))
        .is_some_and(|secs| !secs.is_empty() && secs.chars().all(|c| c.is_ascii_digit()))
}

fn list_in(dir: &Path) -> Vec<Recording> {
    let mut out: Vec<Recording> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let meta = e.metadata().ok().filter(|m| m.is_file())?;
            let modified = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs();
            is_recording_name(&name).then_some(Recording { name, bytes: meta.len(), modified })
        })
        .collect();
    out.sort_by(|a, b| b.modified.cmp(&a.modified).then(a.name.cmp(&b.name)));
    out
}

#[tauri::command(async)]
pub fn valorant_recordings() -> Vec<Recording> {
    list_in(&dir())
}

/// Deletes one recording by name, or every recording (`None`). The one being written is left alone.
#[tauri::command(async)]
pub fn valorant_recordings_delete(name: Option<String>) -> Result<usize, String> {
    let busy = RUNNING.lock().unwrap().as_ref().map(|r| r.file.clone());
    let mut gone = 0;
    for rec in list_in(&dir()) {
        if name.as_ref().is_some_and(|n| *n != rec.name) {
            continue;
        }
        let path = dir().join(&rec.name);
        if busy.as_ref() == Some(&path) {
            continue;
        }
        fs::remove_file(&path).map_err(|e| e.to_string())?;
        gone += 1;
    }
    Ok(gone)
}

#[tauri::command]
pub fn valorant_recordings_reveal() {
    let dir = dir();
    let _ = fs::create_dir_all(&dir);
    platform::reveal_folder(&dir.to_string_lossy());
}

#[cfg(test)]
mod tests {
    use super::*;

    const GB: u64 = 1 << 30;

    #[test]
    fn it_starts_only_when_asked_with_the_window_there_and_room_on_the_drive() {
        assert_eq!(decide(true, true, false, Some(10 * GB), false), Action::Start);
        assert_eq!(decide(false, true, false, Some(10 * GB), false), Action::Nothing, "setting off");
        assert_eq!(decide(true, false, false, Some(10 * GB), false), Action::Nothing, "no game window");
        assert_eq!(decide(true, true, false, Some(GB), false), Action::Nothing, "drive short of space");
        assert_eq!(decide(true, true, false, None, false), Action::Start, "free space unknown");
    }

    #[test]
    fn it_stops_when_the_window_goes_the_setting_goes_off_the_time_is_up_or_the_disk_fills() {
        assert_eq!(decide(true, true, true, Some(10 * GB), false), Action::Nothing);
        assert_eq!(decide(true, false, true, Some(10 * GB), false), Action::Stop);
        assert_eq!(decide(false, true, true, Some(10 * GB), false), Action::Stop);
        assert_eq!(decide(true, true, true, Some(10 * GB), true), Action::Stop);
        assert_eq!(decide(true, true, true, Some(MIN_KEEP_BYTES - 1), false), Action::Stop);
        // Between the two thresholds a recording goes on but a new one does not start.
        assert_eq!(decide(true, true, true, Some(GB), false), Action::Nothing);
    }

    #[test]
    fn ffmpeg_captures_that_window_alone_into_a_file_that_survives_a_crash() {
        let args = ffmpeg_args("VALORANT  ", Path::new("out.mp4"));
        let joined = args.join(" ");
        assert!(joined.contains("-f gdigrab"));
        assert!(args.contains(&"title=VALORANT  ".to_string()), "the window, not the desktop");
        assert!(!joined.contains("desktop"));
        assert!(joined.contains("-movflags +frag_keyframe+empty_moov"));
        assert!(joined.contains(&format!("-t {MAX_SECS}")));
        assert_eq!(args.last().unwrap(), "out.mp4");
        // Without an audio input, nothing but the game window's picture is taken.
        assert!(!joined.contains("dshow") && !joined.contains("-f wasapi"));
    }

    #[test]
    fn only_our_own_recordings_are_listed_and_named() {
        assert_eq!(file_name(1700000000), "match-1700000000.mp4");
        assert!(is_recording_name("match-1700000000.mp4"));
        for bad in ["match-.mp4", "match-1.mp4.tmp", "../match-1.mp4", "notes.txt", "match-x.mp4"] {
            assert!(!is_recording_name(bad), "{bad}");
        }
        let dir = std::env::temp_dir().join(format!("coucou-rec-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("match-5.mp4"), [0u8; 10]).unwrap();
        fs::write(dir.join("other.mp4"), [0u8; 10]).unwrap();
        let listed = list_in(&dir);
        assert_eq!(listed.len(), 1);
        assert_eq!((listed[0].name.as_str(), listed[0].bytes), ("match-5.mp4", 10));
        let _ = fs::remove_dir_all(&dir);
    }
}
