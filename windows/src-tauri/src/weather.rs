// The weather beside the compact island's clock.
//
// Nothing is asked of anyone until the user picks a place in Settings →
// General. Picking one asks Open-Meteo's place search for what was typed; from
// then on Open-Meteo (no account, no key) is asked for the weather at that
// place's coordinates, and for nothing else. The page cannot make the request
// itself (its content policy lets it talk to Coucou only), and never sees more
// than what the icon needs.

use std::time::Duration;

use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::i18n::{t, tf};
use crate::net;

const SEARCH_URL: &str = "https://geocoding-api.open-meteo.com/v1/search";
const NOW_URL: &str = "https://api.open-meteo.com/v1/forecast";
/// Places offered for one search.
const MAX_PLACES: usize = 6;
/// What is typed is cut to this before it is sent.
const MAX_QUERY: usize = 80;
const TIMEOUT: Duration = Duration::from_secs(10);

/// `settings.weather`: the place picked in Settings → General.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct WeatherPlace {
    pub name: String,
    pub latitude: f64,
    pub longitude: f64,
}

impl WeatherPlace {
    /// A spot on the globe: the settings file can hold any numbers.
    fn on_earth(&self) -> bool {
        self.latitude.is_finite()
            && self.longitude.is_finite()
            && (-90.0..=90.0).contains(&self.latitude)
            && (-180.0..=180.0).contains(&self.longitude)
    }
}

/// A place found by name, for the settings window to offer.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Place {
    pub name: String,
    /// What tells two places of the same name apart: "Gyeonggi-do, South Korea".
    pub region: String,
    pub latitude: f64,
    pub longitude: f64,
}

/// The weather right now, as much of it as the island shows.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Now {
    /// The WMO weather code (core/weather.ts turns it into an icon).
    pub code: u32,
    pub is_day: bool,
    /// °C.
    pub temperature: f64,
}

/// The two letters Open-Meteo names a language by; English for anything else.
fn language_code(language: &str) -> String {
    let code: String = language.chars().take_while(|c| c.is_ascii_alphabetic()).take(2).collect::<String>().to_lowercase();
    if code.len() == 2 { code } else { "en".to_string() }
}

async fn get(url: Url) -> Result<Value, String> {
    let response = net::client(&url, TIMEOUT)?
        .get(url)
        .send()
        .await
        .map_err(|e| tf("Network error: {error}", &[("error", &e.without_url().to_string())]))?;
    if !response.status().is_success() {
        return Err(format!("Open-Meteo: HTTP {}", response.status().as_u16()));
    }
    let bytes = net::read_capped(response, net::MAX_BODY).await?;
    serde_json::from_slice(&bytes).map_err(|_| t("Unexpected API response."))
}

/// Settings → General → Weather: the places called what was typed.
pub async fn search(query: &str, language: &str) -> Result<Vec<Place>, String> {
    let query: String = query.trim().chars().take(MAX_QUERY).collect();
    if query.chars().count() < 2 {
        return Ok(Vec::new());
    }
    let count = MAX_PLACES.to_string();
    let language = language_code(language);
    let names = spellings(&query);
    let mut found = Vec::new();
    for (i, name) in names.iter().enumerate() {
        let url = Url::parse_with_params(
            SEARCH_URL,
            [("name", name.as_str()), ("count", count.as_str()), ("language", language.as_str()), ("format", "json")],
        )
        .map_err(|e| e.to_string())?;
        match get(url).await {
            Ok(body) => found.extend(parse_places(&body)),
            // What was typed must be answered; a longer spelling may fail quietly.
            Err(err) if i == 0 => return Err(err),
            Err(_) => {}
        }
    }
    Ok(offer(found, names.len() > 1))
}

/// The names to search for. The service knows a Korean city by its full name
/// only ("서울" finds nothing, "서울특별시" finds Seoul, and "부산" finds
/// villages before 부산광역시), so a Korean name that carries no such ending
/// is also asked for with each of them.
fn spellings(query: &str) -> Vec<String> {
    let mut names = vec![query.to_string()];
    let korean = query.chars().any(|c| ('가'..='힣').contains(&c));
    if korean && !query.ends_with(['시', '군', '구', '도', '읍', '면', '동', '리']) {
        names.extend(["특별시", "광역시", "시", "군"].iter().map(|ending| format!("{query}{ending}")));
    }
    names
}

/// A place and how many live there (0 when the service does not say).
#[derive(Debug, Clone, PartialEq)]
struct Found {
    place: Place,
    population: f64,
}

fn parse_places(body: &Value) -> Vec<Found> {
    let text = |item: &Value, key: &str| item.get(key).and_then(Value::as_str).unwrap_or("").trim().to_string();
    body.get("results")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let name = text(item, "name");
            let place = WeatherPlace {
                name: name.clone(),
                latitude: item.get("latitude")?.as_f64()?,
                longitude: item.get("longitude")?.as_f64()?,
            };
            if name.is_empty() || !place.on_earth() {
                return None;
            }
            let region: Vec<String> =
                [text(item, "admin1"), text(item, "country")].into_iter().filter(|part| !part.is_empty() && *part != name).collect();
            Some(Found {
                place: Place { name, region: region.join(", "), latitude: place.latitude, longitude: place.longitude },
                population: item.get("population").and_then(Value::as_f64).unwrap_or(0.0),
            })
        })
        .collect()
}

/// The places to offer: each once, no more than fit. The service's own order
/// is kept for one spelling; several spellings are merged largest town first,
/// which is the one meant far more often than a hamlet of the same name.
fn offer(mut found: Vec<Found>, by_size: bool) -> Vec<Place> {
    if by_size {
        found.sort_by(|a, b| b.population.total_cmp(&a.population));
    }
    let mut places: Vec<Place> = Vec::new();
    for one in found {
        let same = |p: &Place| (p.latitude - one.place.latitude).abs() < 0.01 && (p.longitude - one.place.longitude).abs() < 0.01;
        if !places.iter().any(same) {
            places.push(one.place);
        }
        if places.len() == MAX_PLACES {
            break;
        }
    }
    places
}

/// The weather at `place` right now.
pub async fn now(place: &WeatherPlace) -> Result<Now, String> {
    if !place.on_earth() {
        return Err(t("Unexpected API response."));
    }
    // Two decimals is about a kilometre: all a forecast is good for, and no more is sent.
    let latitude = format!("{:.2}", place.latitude);
    let longitude = format!("{:.2}", place.longitude);
    let url = Url::parse_with_params(
        NOW_URL,
        [("latitude", latitude.as_str()), ("longitude", longitude.as_str()), ("current", "temperature_2m,weather_code,is_day")],
    )
    .map_err(|e| e.to_string())?;
    parse_now(&get(url).await?).ok_or_else(|| t("Unexpected API response."))
}

fn parse_now(body: &Value) -> Option<Now> {
    let current = body.get("current")?;
    let code = current.get("weather_code")?.as_f64()?;
    if !(0.0..=99.0).contains(&code) {
        return None;
    }
    Some(Now {
        code: code as u32,
        is_day: current.get("is_day").and_then(Value::as_f64).unwrap_or(1.0) != 0.0,
        temperature: current.get("temperature_2m").and_then(Value::as_f64).unwrap_or(0.0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn places_are_told_apart_by_their_region() {
        let body = json!({"results":[
            {"name":"Seoul","latitude":37.566,"longitude":126.9784,"country":"South Korea","admin1":"Seoul"},
            {"name":"Springfield","latitude":39.80,"longitude":-89.64,"country":"United States","admin1":"Illinois"},
            {"name":"Nowhere","latitude":"x","longitude":1.0},
            {"name":"","latitude":1.0,"longitude":1.0},
            {"name":"Off the map","latitude":91.0,"longitude":0.0},
            {"name":"Bare","latitude":-33.9,"longitude":18.4}
        ]});
        let places = offer(parse_places(&body), false);
        assert_eq!(places.len(), 3);
        // A region named like the place adds nothing: only the country is kept.
        assert_eq!(places[0], Place { name: "Seoul".into(), region: "South Korea".into(), latitude: 37.566, longitude: 126.9784 });
        assert_eq!(places[1].region, "Illinois, United States");
        assert_eq!(places[2].region, "");
        // No place by that name: Open-Meteo sends no list at all.
        assert!(parse_places(&json!({"generationtime_ms":0.3})).is_empty());
    }

    #[test]
    fn no_more_places_than_fit_are_offered() {
        let many: Vec<Value> = (0..20).map(|i| json!({"name":format!("P{i}"),"latitude":f64::from(i),"longitude":2.0})).collect();
        assert_eq!(offer(parse_places(&json!({ "results": many })), false).len(), MAX_PLACES);
    }

    #[test]
    fn a_korean_city_is_also_asked_for_by_its_full_names() {
        assert_eq!(spellings("서울"), ["서울", "서울특별시", "서울광역시", "서울시", "서울군"]);
        // A name that already says what it is, or is not Korean, goes as typed.
        assert_eq!(spellings("수원시"), ["수원시"]);
        assert_eq!(spellings("Seoul"), ["Seoul"]);
    }

    #[test]
    fn several_spellings_are_merged_largest_first_each_place_once() {
        let hamlets = json!({"results":[
            {"name":"Pusan","latitude":36.38,"longitude":128.37,"country":"대한민국","admin1":"경상북도"},
            {"name":"Pusan","latitude":35.14,"longitude":128.46,"country":"대한민국","admin1":"경상남도"}
        ]});
        let city = json!({"results":[
            {"name":"부산광역시","latitude":35.10168,"longitude":129.03004,"country":"대한민국","admin1":"부산광역시","population":3285147},
            {"name":"부산광역시","latitude":35.1017,"longitude":129.0300,"country":"대한민국","population":3285147}
        ]});
        let mut found = parse_places(&hamlets);
        found.extend(parse_places(&city));
        let places = offer(found.clone(), true);
        assert_eq!(places.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["부산광역시", "Pusan", "Pusan"]);
        // One spelling keeps the order the service gave.
        assert_eq!(offer(found, false)[0].name, "Pusan");
    }

    #[test]
    fn the_weather_is_the_code_and_whether_it_is_day() {
        let body = json!({"current":{"time":"2026-10-11T18:00","interval":900,"temperature_2m":17.4,"weather_code":61,"is_day":0}});
        assert_eq!(parse_now(&body), Some(Now { code: 61, is_day: false, temperature: 17.4 }));
        let day = json!({"current":{"weather_code":0,"is_day":1,"temperature_2m":-3.0}});
        assert_eq!(parse_now(&day), Some(Now { code: 0, is_day: true, temperature: -3.0 }));
        assert_eq!(parse_now(&json!({"current":{"is_day":1}})), None);
        assert_eq!(parse_now(&json!({"current":{"weather_code":250}})), None);
        assert_eq!(parse_now(&json!({"error":true,"reason":"bad"})), None);
    }

    #[test]
    fn only_a_spot_on_the_globe_is_asked_about() {
        let at = |latitude, longitude| WeatherPlace { name: "x".into(), latitude, longitude };
        assert!(at(37.57, 126.98).on_earth());
        assert!(at(-90.0, 180.0).on_earth());
        assert!(!at(90.5, 0.0).on_earth());
        assert!(!at(0.0, -181.0).on_earth());
        assert!(!at(f64::NAN, 0.0).on_earth());
    }

    #[test]
    fn the_language_is_two_letters_or_english() {
        assert_eq!(language_code("ko"), "ko");
        assert_eq!(language_code("pt-BR"), "pt");
        assert_eq!(language_code("zh-Hans"), "zh");
        assert_eq!(language_code(""), "en");
        assert_eq!(language_code("x&count=99"), "en");
    }

    /// The real service: one search and one forecast. Run by hand
    /// (`cargo test live_weather -- --ignored --nocapture`).
    #[test]
    #[ignore]
    fn live_weather_finds_seoul_and_its_sky() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let places = rt.block_on(search("서울", "ko")).unwrap();
        println!("{places:?}");
        let first = places.first().expect("a place");
        let place = WeatherPlace { name: first.name.clone(), latitude: first.latitude, longitude: first.longitude };
        let now = rt.block_on(now(&place)).unwrap();
        println!("{now:?}");
        assert!(now.code <= 99);
    }
}
