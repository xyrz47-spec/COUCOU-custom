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
/// Icons tried for one site before giving up.
const MAX_TRIES: usize = 4;

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

/// The icon of entry `index` when it is a website, as a data URL; `None` when
/// the site has none we could read.
#[tauri::command]
pub async fn launcher_favicon(shared: State<'_, Shared>, index: usize) -> Result<Option<String>, ()> {
    let target = shared.settings.lock().unwrap().launcher.get(index).map(|item| item.target.trim().to_string());
    match target {
        Some(target) if is_web(&target) => Ok(favicon(&target).await),
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
