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

// ── Its face ──────────────────────────────────────────────────────────────────

/**
 * `settings.clockFace`: the letters the clock is set in (style.css,
 * #compact-clock.face-…). "" is the balanced one: figures of one width drawn
 * for it, the same weight as the words beside them. "square" is the squared
 * face the app carries, "mono" a typewriter's, "narrow" a condensed one.
 */
export const CLOCK_FACES = ["", "square", "mono", "narrow"] as const;
export type ClockFace = (typeof CLOCK_FACES)[number];

export function isClockFace(value: unknown): value is ClockFace {
  return typeof value === "string" && (CLOCK_FACES as readonly string[]).includes(value);
}

/** The face in force: one this build doesn't know reads as the balanced one. */
export function clockFace(value: unknown): ClockFace {
  return isClockFace(value) ? value : "";
}

// ── Its size ──────────────────────────────────────────────────────────────────

/** The clock's largest letters, in px: easy to read at a glance, with air above and below. */
export const CLOCK_MAX_FONT = 15;
const CLOCK_MIN_FONT = 9;

/**
 * The size at which the clock fills its stretch of the compact island: a text
 * `width` px wide when set at `at` px, in `room` px. As large as fits, never
 * past its largest. A text that could not be measured keeps `at`.
 */
export function clockFontSize(width: number, at: number, room: number): number {
  if (!(width > 0) || !(room > 0)) return at;
  const fit = Math.floor(((at * room) / width) * 2) / 2;
  return Math.max(CLOCK_MIN_FONT, Math.min(CLOCK_MAX_FONT, fit));
}

/**
 * The clock's text cut into its figures and what stands between them, in
 * order: the island gives every figure a cell of the same width, and sets a
 * word (오후, PM, a month) a little smaller so it weighs no more than the figures.
 */
export function clockParts(text: string): { text: string; figure: boolean; word: boolean }[] {
  return text
    .split(/([0-9])/)
    .filter(Boolean)
    .map((part) => ({ text: part, figure: /^[0-9]$/.test(part), word: /\p{L}/u.test(part) }));
}
