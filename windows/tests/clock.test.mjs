// The compact island's clock (src/core/clock.ts): its forms, and the size at
// which it fills its stretch of the island.

import { test } from "node:test";
import assert from "node:assert/strict";
import { CLOCK_FORMATS, CLOCK_MAX_FONT, clockFontSize, formatClock, isClockFormat } from "../src/core/clock.ts";

const when = new Date(2026, 9, 11, 17, 6, 9);

test("every form reads as picked, and \"off\" as nothing", () => {
  assert.equal(formatClock("24h", when, "en"), "17:06");
  assert.equal(formatClock("24h-seconds", when, "en"), "17:06:09");
  assert.match(formatClock("12h", when, "en"), /^5:06\sPM$/);
  assert.match(formatClock("12h-seconds", when, "en"), /^5:06:09\sPM$/);
  assert.match(formatClock("weekday", when, "en"), /^Sun,? 5:06\sPM$/);
  assert.match(formatClock("date", when, "en"), /^Oct 11,? .*5:06\sPM$/);
  assert.equal(formatClock("off", when, "en"), "");
  assert.equal(formatClock("24h", when, "ko"), "17:06");
  assert.match(formatClock("12h", when, "ko"), /^오후 5:06$/);
});

test("a form this build doesn't know reads as the language's own", () => {
  assert.equal(formatClock("nope", when, "en"), formatClock("", when, "en"));
  assert.ok(isClockFormat("") && isClockFormat("off") && !isClockFormat("nope") && !isClockFormat(3));
  assert.equal(new Set(CLOCK_FORMATS).size, CLOCK_FORMATS.length);
});

test("the clock is as large as its stretch takes, never taller than the island", () => {
  // A short time has room to spare: the island's height is the limit.
  assert.equal(clockFontSize(90, CLOCK_MAX_FONT, 164), CLOCK_MAX_FONT);
  // A long one is brought down until it fits, in half pixels, and does fit.
  const size = clockFontSize(230, CLOCK_MAX_FONT, 164);
  assert.equal(size, 16);
  assert.ok((230 * size) / CLOCK_MAX_FONT <= 164);
  assert.equal(clockFontSize(205, CLOCK_MAX_FONT, 164), 18);
  // Never unreadable, and a text that could not be measured keeps its size.
  assert.equal(clockFontSize(5000, CLOCK_MAX_FONT, 164), 9);
  assert.equal(clockFontSize(0, CLOCK_MAX_FONT, 164), CLOCK_MAX_FONT);
  assert.equal(clockFontSize(undefined, CLOCK_MAX_FONT, undefined), CLOCK_MAX_FONT);
});
