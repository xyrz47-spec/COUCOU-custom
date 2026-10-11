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
