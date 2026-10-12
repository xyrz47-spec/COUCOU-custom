// The island's launcher tab: the websites and apps the user listed in
// Settings → Launcher, opened with one click.
//
// Only what is in the saved list is ever opened: the page asks for an entry by
// its place in that list, never by a path or an address of its own. An entry
// is a web address (http or https, handed to the default browser) or the full
// path of something that exists — an app, a shortcut, a folder, a document —
// opened the way a double-click in the file manager would.
//
// Each tile wears its entry's own icon. A file's comes from the system. A
// website's is fetched from that website and nowhere else — the icon its page
// names, else its /favicon.ico — and handed to the page as a data URL, which
// keeps it, so the site is asked once.

use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{platform, Shared};

/// Tiles the tab has room to be useful with.
pub const MAX_ITEMS: usize = 24;
/// Pixels across of an app's icon, as asked of the system.
const ICON_SIZE: i32 = 96;
/// How much of a page is read to find its icon: they are named in its head.
const PAGE_HEAD: usize = 256 * 1024;
/// The largest icon kept.
const FAVICON_LIMIT: usize = 512 * 1024;
const WEB_TIMEOUT: Duration = Duration::from_secs(8);
/// The largest image file shown as a tile's picture.
const IMAGE_LIMIT: u64 = 4 * 1024 * 1024;
/// Icons tried for one site before giving up.
const MAX_TRIES: usize = 4;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct LauncherItem {
    pub name: String,
    /// `https://…`, or the full path of a file or folder.
    pub target: String,
    /// The full path of an image file of the user's own for the tile to wear,
    /// in place of the entry's icon. Empty for most.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub image: String,
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

/// How an installed app is named as an entry's target: the shell's own
/// address for an item of its Applications folder. Opening it starts the app,
/// whether it is a desktop program or a Store app.
const APP_PREFIX: &str = "shell:AppsFolder\\";

/// `shell:AppsFolder\<id>` with an id that is only an id: the settings file,
/// and the page, can hold any text.
pub fn is_app(target: &str) -> bool {
    let Some(head) = target.get(..APP_PREFIX.len()) else { return false };
    let id = &target[APP_PREFIX.len()..];
    head.eq_ignore_ascii_case(APP_PREFIX)
        && !id.is_empty()
        && id.len() <= 400
        && !id.chars().any(|c| c.is_control() || matches!(c, '"' | '<' | '>' | '|' | '*' | '?'))
}

/// An app found on this PC, for the "add" window to offer.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InstalledApp {
    pub name: String,
    /// What to save as the entry's target.
    pub target: String,
}

/// The Start menu's list as the "add" window shows it: apps only (not the
/// uninstallers, manuals and web links programs put beside themselves), each
/// once, by name.
fn tidy_apps(listed: Vec<(String, String)>) -> Vec<InstalledApp> {
    const NOT_APPS: &[&str] = &[".url", ".chm", ".txt", ".pdf", ".htm", ".html", ".rtf", ".md"];
    let mut apps: Vec<InstalledApp> = listed
        .into_iter()
        .filter_map(|(name, id)| {
            let name = name.trim().to_string();
            let lower_name = name.to_lowercase();
            let lower_id = id.to_lowercase();
            let target = format!("{APP_PREFIX}{id}");
            let keep = !name.is_empty()
                && is_app(&target)
                && !lower_name.contains("uninstall")
                && !name.contains("제거")
                && !NOT_APPS.iter().any(|ending| lower_id.ends_with(ending));
            keep.then_some(InstalledApp { name, target })
        })
        .collect();
    apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then(a.target.cmp(&b.target)));
    apps.dedup_by(|b, a| a.target.eq_ignore_ascii_case(&b.target));
    apps
}

/// The apps installed on this PC, for the "add" window's search.
#[tauri::command(async)]
pub fn launcher_apps(shared: State<Shared>) -> Vec<InstalledApp> {
    // Settings → Features → "Installed apps", off: the Start menu is not read.
    if !crate::features::on(&shared.settings.lock().unwrap(), "launcherApps") {
        return Vec::new();
    }
    tidy_apps(platform::start_apps())
}

/// The icon of an installed app, for the "add" window's list: small, since many are asked for.
#[tauri::command(async)]
pub fn launcher_app_icon(target: String) -> Option<IconPixels> {
    if !is_app(&target) {
        return None;
    }
    let (width, height, rgba) = platform::shell_image(&target, 48)?;
    Some(IconPixels { width, height, rgba: crate::claude::base64_for(&rgba) })
}

/// What can be opened: a web address, an installed app, or an absolute path that is there.
fn openable(target: &str) -> bool {
    let target = target.trim();
    if is_web(target) || is_app(target) {
        return true;
    }
    let path = Path::new(target);
    path.is_absolute() && path.exists()
}

/// For each entry of the saved list, whether it can be opened now: a path
/// that is gone is not removed — Settings says so beside it, and the user decides.
#[tauri::command(async)]
pub fn launcher_status(shared: State<Shared>) -> Vec<bool> {
    let items = shared.settings.lock().unwrap().launcher.clone();
    items.iter().map(|item| openable(&item.target)).collect()
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
#[tauri::command(async)]
pub fn launcher_icon(shared: State<Shared>, index: usize) -> Option<IconPixels> {
    let target = shared.settings.lock().unwrap().launcher.get(index)?.target.trim().to_string();
    if is_web(&target) {
        return None;
    }
    // An installed app has no file of its own to take an icon from: the shell draws it.
    if is_app(&target) {
        let (width, height, rgba) = platform::shell_image(&target, ICON_SIZE)?;
        return Some(IconPixels { width, height, rgba: crate::claude::base64_for(&rgba) });
    }
    let path = Path::new(&target);
    if !path.is_absolute() || !path.exists() {
        return None;
    }
    let (width, height, rgba) = platform::file_icon_rgba(path, ICON_SIZE)?;
    Some(IconPixels { width, height, rgba: crate::claude::base64_for(&rgba) })
}

/// The picture the user chose for entry `index`, as a data URL; `None` when
/// there is none, or the file is not an image the page can show.
#[tauri::command(async)]
pub fn launcher_image(shared: State<Shared>, index: usize) -> Option<String> {
    let image = shared.settings.lock().unwrap().launcher.get(index)?.image.trim().to_string();
    image_data_url(Path::new(&image))
}

/// The image at `path` as a data URL, for the "add" window to show the
/// picture just dropped on it; `None` for anything that is not an image.
#[tauri::command(async)]
pub fn launcher_image_at(path: String) -> Option<String> {
    image_data_url(Path::new(path.trim()))
}

/// Where the pictures picked through the file dialog are kept: the page has
/// their bytes, not their path, so the app keeps a copy of its own.
fn images_dir() -> std::path::PathBuf {
    platform::config_dir().join("launcher-images")
}

/// Keeps a picked picture (a `data:` URL, as the page read it) and says where.
/// Only an image, and no larger than one shown from disk.
#[tauri::command(async)]
pub fn launcher_store_image(data: String) -> Result<String, String> {
    let encoded = data.split_once("base64,").map(|(_, rest)| rest).ok_or("Not an image.")?;
    let bytes = base64_decode(encoded).ok_or("Not an image.")?;
    if bytes.len() as u64 > IMAGE_LIMIT {
        return Err("That image is too large.".into());
    }
    let ext = match image_mime(&bytes).ok_or("Not an image.")? {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/x-icon" => "ico",
        "image/bmp" => "bmp",
        _ => "svg",
    };
    let dir = images_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    let path = dir.join(format!("{stamp}.{ext}"));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// The kept pictures no entry wears any more are let go (an entry removed, a
/// form closed without adding). Only files of the app's own folder.
pub fn prune_images(items: &[LauncherItem]) {
    let Ok(entries) = std::fs::read_dir(images_dir()) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let worn = items.iter().any(|item| Path::new(item.image.trim()) == path);
        if !worn && path.is_file() {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Standard base64, padding or not; `None` for anything else.
fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let (mut bits, mut count) = (0u32, 0u8);
    for c in text.bytes() {
        let value = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\r' | b'\n' => continue,
            _ => return None,
        };
        bits = (bits << 6) | value as u32;
        count += 1;
        if count == 4 {
            out.extend_from_slice(&[(bits >> 16) as u8, (bits >> 8) as u8, bits as u8]);
            (bits, count) = (0, 0);
        }
    }
    match count {
        0 => {}
        2 => out.push((bits >> 4) as u8),
        3 => out.extend_from_slice(&[(bits >> 10) as u8, (bits >> 2) as u8]),
        _ => return None,
    }
    Some(out)
}

fn image_data_url(path: &Path) -> Option<String> {
    if !path.is_absolute() {
        return None;
    }
    let meta = std::fs::metadata(path).ok().filter(|m| m.is_file() && m.len() <= IMAGE_LIMIT)?;
    let _ = meta;
    let bytes = std::fs::read(path).ok()?;
    let mime = image_mime(&bytes)?;
    Some(format!("data:{mime};base64,{}", crate::claude::base64_for(&bytes)))
}

/// The icon of entry `index` when it is a website, as a data URL; `None` when
/// the site has none we could read.
#[tauri::command]
pub async fn launcher_favicon(shared: State<'_, Shared>, index: usize) -> Result<Option<String>, ()> {
    let (target, allowed) = {
        let settings = shared.settings.lock().unwrap();
        (
            settings.launcher.get(index).map(|item| item.target.trim().to_string()),
            crate::features::on(&settings, "launcherFavicons"),
        )
    };
    match target {
        // Settings → Features → "Website icons", off: the site is not asked.
        Some(target) if allowed && is_web(&target) => Ok(favicon(&target).await),
        _ => Ok(None),
    }
}

async fn favicon(target: &str) -> Option<String> {
    let page = reqwest::Url::parse(target).ok()?;
    let client = reqwest::Client::builder()
        .timeout(WEB_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(5))
        // Some sites answer a client without one with an error page.
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Coucou")
        .build()
        .ok()?;

    // The page names its icons; the usual place comes last.
    let mut candidates: Vec<reqwest::Url> = Vec::new();
    let mut origin = page.clone();
    if let Ok(response) = client.get(page.clone()).send().await {
        if response.status().is_success() {
            origin = response.url().clone();
            let head = read_head(response, PAGE_HEAD).await;
            for href in icon_links(&String::from_utf8_lossy(&head)) {
                if let Ok(url) = origin.join(&href) {
                    candidates.push(url);
                }
            }
        }
    }
    for base in [&origin, &page] {
        if let Ok(url) = base.join("/favicon.ico") {
            if !candidates.contains(&url) {
                candidates.push(url);
            }
        }
    }

    for url in candidates.into_iter().filter(|u| matches!(u.scheme(), "http" | "https")).take(MAX_TRIES) {
        let Ok(response) = client.get(url).send().await else { continue };
        if !response.status().is_success() {
            continue;
        }
        let Ok(bytes) = crate::net::read_capped(response, FAVICON_LIMIT).await else { continue };
        if let Some(mime) = image_mime(&bytes) {
            return Some(format!("data:{mime};base64,{}", crate::claude::base64_for(&bytes)));
        }
    }
    None
}

/// The first `limit` bytes of a body; whatever comes after is not read.
async fn read_head(mut response: reqwest::Response, limit: usize) -> Vec<u8> {
    let mut body = Vec::new();
    while let Ok(Some(chunk)) = response.chunk().await {
        let room = limit - body.len();
        body.extend_from_slice(&chunk[..chunk.len().min(room)]);
        if body.len() >= limit {
            break;
        }
    }
    body
}

/// The value of attribute `name` in the text of one tag.
fn attribute(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let mut from = 0;
    while let Some(found) = lower[from..].find(name) {
        let at = from + found;
        from = at + name.len();
        // A whole attribute name, not the tail of another ("data-href").
        let starts = at == 0 || lower.as_bytes()[at - 1].is_ascii_whitespace();
        let rest = tag[from..].trim_start();
        if !starts || !rest.starts_with('=') {
            continue;
        }
        let value = rest[1..].trim_start();
        let text = match value.chars().next() {
            Some(quote @ ('"' | '\'')) => value[1..].split(quote).next().unwrap_or(""),
            _ => value.split(|c: char| c.is_ascii_whitespace() || c == '>').next().unwrap_or(""),
        };
        return Some(text.trim().replace("&amp;", "&"));
    }
    None
}

/// The icons a page names in its `<link>` tags, the largest first. A touch
/// icon is the big one sites keep for home screens; a plain icon says its size
/// or is taken for a small one. Pinned-tab masks are one flat colour: left out.
pub fn icon_links(html: &str) -> Vec<String> {
    let lower = html.to_ascii_lowercase();
    let mut found: Vec<(u32, String)> = Vec::new();
    let mut from = 0;
    while let Some(start) = lower[from..].find("<link") {
        let at = from + start;
        let end = lower[at..].find('>').map_or(lower.len(), |e| at + e);
        from = end;
        let tag = &html[at..end];
        let rel = attribute(tag, "rel").unwrap_or_default().to_ascii_lowercase();
        let Some(href) = attribute(tag, "href").filter(|h| !h.is_empty() && !h.starts_with("data:")) else {
            continue;
        };
        if !rel.split_ascii_whitespace().any(|r| r == "icon" || r.starts_with("apple-touch-icon")) {
            continue;
        }
        let stated = attribute(tag, "sizes")
            .and_then(|s| s.to_ascii_lowercase().split('x').next().and_then(|w| w.trim().parse::<u32>().ok()));
        let size = stated.unwrap_or(if rel.contains("apple-touch-icon") { 180 } else { 32 });
        found.push((size, href));
    }
    // Largest first; among equals, the order the page gave them.
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().map(|(_, href)| href).collect()
}

/// The image type of `bytes`, from how they start: what a browser will draw.
pub fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        return Some("image/png");
    }
    if bytes.starts_with(&[0, 0, 1, 0]) {
        return Some("image/x-icon");
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF8") {
        return Some("image/gif");
    }
    if bytes.starts_with(b"BM") && bytes.len() > 26 {
        return Some("image/bmp");
    }
    if bytes.len() > 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    let start = String::from_utf8_lossy(&bytes[..bytes.len().min(1024)]).trim_start().to_ascii_lowercase();
    if start.starts_with("<svg") || (start.starts_with("<?xml") && start.contains("<svg")) {
        return Some("image/svg+xml");
    }
    None
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

    #[test]
    fn a_pages_icons_are_found_largest_first() {
        let html = r##"<html><head>
            <LINK REL="shortcut icon" HREF="/favicon.ico">
            <link rel="stylesheet" href="/site.css">
            <link href='/icon-192.png?v=2&amp;x=1' sizes='192x192' rel='icon' type="image/png">
            <link rel="apple-touch-icon" href="https://cdn.example.com/touch.png">
            <link rel="mask-icon" href="/mask.svg" color="#000">
            <link rel=icon href=/small.png sizes=16x16>
            <a data-href="/not-an-icon" rel="icon">x</a>
        </head></html>"##;
        assert_eq!(
            icon_links(html),
            ["/icon-192.png?v=2&x=1", "https://cdn.example.com/touch.png", "/favicon.ico", "/small.png"]
        );
        assert!(icon_links("<p>No head here</p>").is_empty());
        // A tag cut off by the end of what was read is still a tag.
        assert_eq!(icon_links(r#"<link rel="icon" href="/cut.png""#), ["/cut.png"]);
    }

    /// Asks real websites: run by hand (`cargo test -- --ignored`), never with the others.
    #[test]
    #[ignore]
    fn live_sites_give_an_icon() {
        for site in ["https://github.com", "https://www.wikipedia.org"] {
            let icon = tauri::async_runtime::block_on(favicon(site));
            let icon = icon.unwrap_or_else(|| panic!("no icon for {site}"));
            assert!(icon.starts_with("data:image/"), "{site}");
            println!("{site}: {} ({} bytes)", &icon[..icon.find(';').unwrap_or(20)], icon.len());
        }
    }

    #[test]
    fn a_picture_of_the_users_own_is_read_only_when_it_is_an_image() {
        let dir = std::env::temp_dir().join(format!("coucou-launcher-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let png = dir.join("tile.png");
        std::fs::write(&png, [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]).unwrap();
        assert_eq!(image_data_url(&png).as_deref(), Some("data:image/png;base64,iVBORw0KGgo="));
        // A file that is not an image, a folder, a path that is not full, nothing at all.
        let text = dir.join("notes.png");
        std::fs::write(&text, "just text").unwrap();
        assert_eq!(image_data_url(&text), None);
        assert_eq!(image_data_url(&dir), None);
        assert_eq!(image_data_url(Path::new("tile.png")), None);
        assert_eq!(image_data_url(Path::new("")), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn base64_reads_back_what_was_written() {
        for bytes in [&b""[..], b"a", b"ab", b"abc", b"abcd", &[0xFF, 0x00, 0x89, b'P', b'N', b'G', 0x0D]] {
            assert_eq!(base64_decode(&crate::claude::base64_for(bytes)).as_deref(), Some(bytes));
        }
        // Without its padding, and not base64 at all.
        assert_eq!(base64_decode("YWI").as_deref(), Some(&b"ab"[..]));
        assert_eq!(base64_decode("a b"), None);
        assert_eq!(base64_decode("a"), None);
    }

    #[test]
    fn what_is_handed_over_as_a_picture_has_to_be_an_image() {
        let text = format!("data:text/plain;base64,{}", crate::claude::base64_for(b"just text"));
        assert!(launcher_store_image(text).is_err());
        assert!(launcher_store_image("data:image/png,not-base64".into()).is_err());
        assert!(launcher_store_image("data:image/png;base64,***".into()).is_err());
    }

    #[test]
    fn an_entry_without_a_picture_is_saved_without_one() {
        let plain = LauncherItem { name: "Docs".into(), target: "https://example.com".into(), image: String::new() };
        assert_eq!(serde_json::to_string(&plain).unwrap(), r#"{"name":"Docs","target":"https://example.com"}"#);
        let back: LauncherItem = serde_json::from_str(r#"{"name":"Docs","target":"https://example.com"}"#).unwrap();
        assert_eq!(back, plain);
    }

    #[test]
    fn only_what_starts_like_an_image_is_one() {
        assert_eq!(image_mime(&[0x89, b'P', b'N', b'G', 0x0D]), Some("image/png"));
        assert_eq!(image_mime(&[0, 0, 1, 0, 2, 0]), Some("image/x-icon"));
        assert_eq!(image_mime(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(image_mime(b"GIF89a"), Some("image/gif"));
        assert_eq!(image_mime(b"RIFF\x10\x00\x00\x00WEBPVP8 "), Some("image/webp"));
        assert_eq!(image_mime(b"  <svg xmlns='http://www.w3.org/2000/svg'/>"), Some("image/svg+xml"));
        assert_eq!(image_mime(b"<?xml version='1.0'?><svg/>"), Some("image/svg+xml"));
        // A "not found" page served in an icon's place.
        assert_eq!(image_mime(b"<!doctype html><html>"), None);
        assert_eq!(image_mime(&[]), None);
    }
}

#[cfg(test)]
mod app_tests {
    use super::*;

    fn listed(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(name, id)| (name.to_string(), id.to_string())).collect()
    }

    #[test]
    fn an_installed_app_is_named_by_the_shells_own_address() {
        assert!(is_app(r"shell:AppsFolder\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"));
        assert!(is_app(r"SHELL:appsfolder\Chrome"));
        assert!(is_app(r"shell:AppsFolder\{6D809377-6AF0-444B-8957-A3773F02200E}\CurseForge\CurseForge.exe"));
        for bad in [
            r"shell:AppsFolder\",
            "shell:AppsFolder",
            "shell:startup",
            "shell:AppsFolder\\a\" & calc",
            "shell:AppsFolder\\a\nb",
            r"C:\Windows\explorer.exe",
            "https://example.com",
            "",
        ] {
            assert!(!is_app(bad), "{bad}");
        }
        // It opens like a path does, without having to be a file.
        assert!(openable(r"shell:AppsFolder\Chrome"));
        assert!(!openable(r"shell:AppsFolder\"));
    }

    #[test]
    fn the_list_keeps_apps_only_each_once_by_name() {
        let apps = tidy_apps(listed(&[
            ("Visual Studio Code", "Microsoft.VisualStudioCode"),
            ("calculator", "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"),
            ("Uninstall Thing", r"{6D80}\Thing\unins000.exe"),
            ("Thing 제거", r"{6D80}\Thing\remove.exe"),
            ("Thing Help", r"{6D80}\Thing\help.CHM"),
            ("Thing on the Web", r"{6D80}\Thing\site.url"),
            ("Thing", r"{6D80}\Thing\thing.exe"),
            ("Thing", r"{6D80}\Thing\thing.exe"),
            ("  ", "Blank.Name"),
            ("Bad", "id\nwith a line break"),
        ]));
        let names: Vec<&str> = apps.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names, ["calculator", "Thing", "Visual Studio Code"]);
        assert_eq!(apps[1].target, r"shell:AppsFolder\{6D80}\Thing\thing.exe");
        assert!(apps.iter().all(|a| is_app(&a.target)));
    }

    /// This PC's own Start menu. Run by hand
    /// (`cargo test live_apps -- --ignored --nocapture`).
    #[test]
    #[ignore]
    #[cfg(windows)]
    fn live_apps_are_listed_with_their_pictures() {
        let apps = tidy_apps(platform::start_apps());
        println!("{} apps; first: {:?}", apps.len(), apps.iter().take(8).map(|a| &a.name).collect::<Vec<_>>());
        assert!(apps.len() > 10);
        let pictured = apps.iter().take(12).filter(|a| launcher_app_icon(a.target.clone()).is_some()).count();
        println!("{pictured} of the first 12 have a picture");
        assert!(pictured >= 6);
        let icon = launcher_app_icon(apps[0].target.clone()).unwrap();
        println!("{}x{}", icon.width, icon.height);
        assert!(icon.width >= 32 && icon.width == icon.height);
    }
}
