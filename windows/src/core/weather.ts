// The weather beside the compact island's clock (weather.rs asks for it).
// Pure: a WMO weather code and whether it is day in, the kind of sky out.

/** `settings.weather`: the place picked in Settings → General. */
export interface WeatherPlace {
  name: string;
  latitude: number;
  longitude: number;
}

/** A place found by name, for the settings window to offer. */
export interface FoundPlace {
  name: string;
  region: string;
  latitude: number;
  longitude: number;
}

/** What weather.rs reports: the WMO code, day or night, °C. */
export interface WeatherNow {
  code: number;
  isDay: boolean;
  temperature: number;
}

export type WeatherKind =
  | "clear-day" | "clear-night" | "partly-day" | "partly-night"
  | "cloudy" | "fog" | "drizzle" | "rain" | "snow" | "thunder";

/** The weather is asked again this often while a place is picked. */
export const WEATHER_REFRESH_MS = 20 * 60 * 1000;

/**
 * The sky a WMO weather code stands for (the table Open-Meteo documents).
 * A code outside it reads as cloudy rather than as nothing.
 */
export function weatherKind(code: number, isDay: boolean): WeatherKind {
  if (code === 0) return isDay ? "clear-day" : "clear-night";
  if (code === 1 || code === 2) return isDay ? "partly-day" : "partly-night";
  if (code === 3) return "cloudy";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 95 && code <= 99) return "thunder";
  return "cloudy";
}
