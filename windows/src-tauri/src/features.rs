// The feature manager, Rust side. The same declarations as the island and the
// settings window (src/core/features.json, included at build time): which
// features there are, what each is part of, which pills belong to it. A
// feature is on when its own switch is on (settings.disabled_features does not
// list it) and so is the one it is part of.
//
// Code that belongs to a feature asks `on(settings, "id")` before it works, so
// a feature turned off in Settings → Features costs nothing.

use std::sync::OnceLock;

use serde::Deserialize;

use crate::settings::Settings;

#[derive(Debug, Deserialize)]
struct Feature {
    id: String,
    #[serde(default)]
    needs: Option<String>,
    #[serde(default)]
    pills: Vec<String>,
    /// Off until turned on (settings.enabled_features).
    #[serde(default, rename = "optIn")]
    opt_in: bool,
}

#[derive(Debug, Deserialize)]
struct Manifest {
    features: Vec<Feature>,
}

fn manifest() -> &'static Manifest {
    static MANIFEST: OnceLock<Manifest> = OnceLock::new();
    MANIFEST.get_or_init(|| {
        serde_json::from_str(include_str!("../../src/core/features.json")).expect("src/core/features.json is not valid")
    })
}

fn switch(settings: &Settings, id: &str) -> bool {
    if manifest().features.iter().any(|f| f.id == id && f.opt_in) {
        return settings.enabled_features.iter().any(|f| f == id);
    }
    !settings.disabled_features.iter().any(|f| f == id)
}

/// The feature is in force: its switch is on, and so is the feature it is part of.
pub fn on(settings: &Settings, id: &str) -> bool {
    if !switch(settings, id) {
        return false;
    }
    match manifest().features.iter().find(|f| f.id == id).and_then(|f| f.needs.as_deref()) {
        Some(parent) => on(settings, parent),
        None => true,
    }
}

/// `pills` without those that belong to a feature that is off.
pub fn allowed_pills(settings: &Settings, pills: &[String]) -> Vec<String> {
    pills
        .iter()
        .filter(|pill| manifest().features.iter().all(|f| !f.pills.contains(pill) || on(settings, &f.id)))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn off(ids: &[&str]) -> Settings {
        Settings { disabled_features: ids.iter().map(|s| s.to_string()).collect(), ..Settings::default() }
    }

    #[test]
    fn an_opt_in_feature_is_off_until_turned_on() {
        let none = Settings::default();
        assert!(on(&none, "twenty") && !on(&none, "twentyPictures"), "Pokémon pictures reach GitHub: off by default");
        let turned_on = Settings { enabled_features: vec!["twentyPictures".into()], ..Settings::default() };
        assert!(on(&turned_on, "twentyPictures"));
        let parent_off = Settings { disabled_features: vec!["twenty".into()], ..turned_on.clone() };
        assert!(!on(&parent_off, "twentyPictures"), "still off with the tab it is part of");
        let listed_off = Settings { disabled_features: vec!["twentyPictures".into()], ..Settings::default() };
        assert!(!on(&listed_off, "twentyPictures"), "the other list does not turn it on");
    }

    #[test]
    fn the_manifest_is_valid_and_every_parent_exists() {
        let m = manifest();
        assert!(m.features.len() >= 10);
        for f in &m.features {
            if let Some(parent) = &f.needs {
                assert!(m.features.iter().any(|p| &p.id == parent), "{} needs a feature that does not exist", f.id);
                assert_ne!(parent, &f.id);
            }
            assert_eq!(m.features.iter().filter(|o| o.id == f.id).count(), 1, "{} is declared twice", f.id);
        }
    }

    #[test]
    fn a_feature_is_off_with_the_one_it_is_part_of() {
        assert!(on(&Settings::default(), "pluginSkills"));
        assert!(!on(&off(&["pluginSkills"]), "pluginSkills"));
        assert!(!on(&off(&["skillsTab"]), "pluginSkills"));
        assert!(on(&off(&["pluginSkills"]), "skillsTab"));
        assert!(!on(&off(&["spotify"]), "musicPlayer"));
    }

    #[test]
    fn the_pills_of_a_feature_that_is_off_are_left_out() {
        let pills = vec!["integration_spotify".to_string(), "integration_github".to_string()];
        assert_eq!(allowed_pills(&Settings::default(), &pills), pills);
        assert_eq!(allowed_pills(&off(&["spotify"]), &pills), ["integration_github"]);
    }
}
