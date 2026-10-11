// The time of day in the compact island (island.ts), in the form picked in
// Settings → General. Pure: a form, a moment and a language in, the text out,
// so the settings window can show each form as it would read right now.

/** `settings.clockFormat`. "" follows the language's own habit. */
export const CLOCK_FORMATS = ["", "12h", "24h", "12h-seconds", "24h-seconds", "weekday", "date", "off"] as const;
export type ClockFormat = (typeof CLOCK_FORMATS)[number];

export function isClockFormat(value: unknown): value is ClockFormat {
  return typeof value === "string" && (CLOCK_FORMATS as readonly string[]).includes(value);
}

function options(format: ClockFormat): Intl.DateTimeFormatOptions | null {
  switch (format) {
    case "":
      return { hour: "numeric", minute: "2-digit" };
    case "12h":
      return { hour: "numeric", minute: "2-digit", hour12: true };
    case "24h":
      return { hour: "2-digit", minute: "2-digit", hour12: false };
    case "12h-seconds":
      return { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true };
    case "24h-seconds":
      return { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false };
    case "weekday":
      return { weekday: "short", hour: "numeric", minute: "2-digit" };
    case "date":
      return { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
    case "off":
      return null;
  }
}

/** The clock's text; "" when it is turned off. A form this build doesn't know reads as the language's own. */
export function formatClock(format: string, when: Date, language: string): string {
  const wanted = options(isClockFormat(format) ? format : "");
  if (!wanted) return "";
  try {
    return new Intl.DateTimeFormat(language, wanted).format(when);
  } catch {
    return `${when.getHours()}:${String(when.getMinutes()).padStart(2, "0")}`;
  }
}

// ── Its size ──────────────────────────────────────────────────────────────────

/** The clock's largest letters, in px: what the compact island's height leaves room for. */
export const CLOCK_MAX_FONT = 23;
const CLOCK_MIN_FONT = 9;

/**
 * The size at which the clock fills its stretch of the compact island: a text
 * `width` px wide when set at `at` px, in `room` px. As large as fits, never
 * taller than the island. A text that could not be measured keeps `at`.
 */
export function clockFontSize(width: number, at: number, room: number): number {
  if (!(width > 0) || !(room > 0)) return at;
  const fit = Math.floor(((at * room) / width) * 2) / 2;
  return Math.max(CLOCK_MIN_FONT, Math.min(CLOCK_MAX_FONT, fit));
}
