// The island's launcher tab: the websites and apps the user listed in
// Settings → Launcher, opened with one click.
//
// Only what is in the saved list is ever opened: the page asks for an entry by
// its place in that list, never by a path or an address of its own. An entry
// is a web address (http or https, handed to the default browser) or the full
// path of something that exists — an app, a shortcut, a folder, a document —
// opened the way a double-click in the file manager would.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{platform, Shared};

/// Tiles the tab has room to be useful with.
pub const MAX_ITEMS: usize = 24;
/// Pixels across of an app's icon, as asked of the system.
const ICON_SIZE: i32 = 96;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct LauncherItem {
    pub name: String,
    /// `https://…`, or the full path of a file or folder.
    pub target: String,
}

/// An icon's pixels, for the page to paint: RGBA, row after row, base64.
#[derive(Serialize)]
pub struct IconPixels {
    pub width: u32,
    pub height: u32,
    pub rgba: String,
}

pub fn is_web(target: &str) -> bool {
    let t = target.trim().to_ascii_lowercase();
    t.starts_with("https://") || t.starts_with("http://")
}

/// What can be opened: a web address, or an absolute path that is there.
fn openable(target: &str) -> bool {
    let target = target.trim();
    if is_web(target) {
        return true;
    }
    let path = Path::new(target);
    path.is_absolute() && path.exists()
}

/// Opens entry `index` of the saved list.
#[tauri::command]
pub fn launcher_open(shared: State<Shared>, index: usize) -> Result<(), String> {
    let item = shared.settings.lock().unwrap().launcher.get(index).cloned();
    let Some(item) = item else { return Err("No such entry.".into()) };
    let target = item.target.trim();
    if !openable(target) {
        return Err(format!("{target} is not there."));
    }
    if is_web(target) {
        platform::open_url(target);
    } else {
        platform::reveal_folder(target);
    }
    crate::log::line(format!("launcher: {}", item.name));
    Ok(())
}

/// The icon of entry `index`, when it is a file the system has one for.
/// Websites have none here: the page draws their tile itself.
#[tauri::command(async)]
pub fn launcher_icon(shared: State<Shared>, index: usize) -> Option<IconPixels> {
    let target = shared.settings.lock().unwrap().launcher.get(index)?.target.trim().to_string();
    if is_web(&target) {
        return None;
    }
    let path = Path::new(&target);
    if !path.is_absolute() || !path.exists() {
        return None;
    }
    let (width, height, rgba) = platform::file_icon_rgba(path, ICON_SIZE)?;
    Some(IconPixels { width, height, rgba: crate::claude::base64_for(&rgba) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_web_address_or_something_that_exists_can_be_opened() {
        assert!(openable("https://example.com/docs"));
        assert!(openable("  HTTP://example.com "));
        assert!(openable(&std::env::temp_dir().to_string_lossy()));
        // Not a path that exists, not a web address: nothing is run.
        assert!(!openable("calc.exe"));
        assert!(!openable("javascript:alert(1)"));
        assert!(!openable("file:///C:/Windows"));
        assert!(!openable(&std::env::temp_dir().join("coucou-not-there-xyz").to_string_lossy()));
        assert!(!openable(""));
    }

    #[cfg(windows)]
    #[test]
    fn an_apps_icon_comes_back_as_pixels() {
        let windows = std::env::var_os("SystemRoot").map(std::path::PathBuf::from).unwrap();
        let (width, height, rgba) = platform::file_icon_rgba(&windows.join("explorer.exe"), ICON_SIZE).unwrap();
        assert!(width > 0 && height > 0);
        assert_eq!(rgba.len(), (width * height * 4) as usize);
        // Something is drawn, and it is not see-through everywhere.
        assert!(rgba.chunks(4).any(|p| p[3] != 0));
        // A folder has an icon too, the shell's.
        assert!(platform::file_icon_rgba(&windows, ICON_SIZE).is_some());
    }
}
