// The weather beside the clock: which sky a WMO code stands for
// (src/core/weather.ts), and that every sky has an icon (src/views/weather.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
const { weatherDegrees, weatherKind } = await import("../src/core/weather.ts");
const { weatherIcon } = await import("../src/views/weather.ts");

test("a clear or half-clear sky knows day from night; the rest look the same", () => {
  assert.equal(weatherKind(0, true), "clear-day");
  assert.equal(weatherKind(0, false), "clear-night");
  assert.equal(weatherKind(1, true), "partly-day");
  assert.equal(weatherKind(2, false), "partly-night");
  assert.equal(weatherKind(3, true), "cloudy");
  assert.equal(weatherKind(3, false), "cloudy");
});

test("every code of the table has its sky", () => {
  const table = {
    fog: [45, 48],
    drizzle: [51, 53, 55, 56, 57],
    rain: [61, 63, 65, 66, 67, 80, 81, 82],
    snow: [71, 73, 75, 77, 85, 86],
    thunder: [95, 96, 99],
  };
  for (const [kind, codes] of Object.entries(table)) {
    for (const code of codes) assert.equal(weatherKind(code, true), kind, String(code));
  }
  // A code the table doesn't have is a grey sky, never an empty spot.
  assert.equal(weatherKind(42, true), "cloudy");
  assert.equal(weatherKind(-1, false), "cloudy");
});

test("every sky has an icon of the asked size", () => {
  const kinds = ["clear-day", "clear-night", "partly-day", "partly-night", "cloudy", "fog", "drizzle", "rain", "snow", "thunder"];
  for (const kind of kinds) {
    const icon = weatherIcon(kind, 17);
    assert.equal(icon.getAttribute("width"), "17");
    assert.equal(icon.getAttribute("data-kind"), kind);
    assert.ok(icon.children.length > 0, kind);
    for (const path of icon.children) {
      assert.match(path.getAttribute("d"), /^M[-0-9. ]/, kind);
      assert.ok(!path.getAttribute("d").includes("NaN"), kind);
    }
  }
});

test("the temperature is written in whole degrees", () => {
  assert.equal(weatherDegrees(17.4), "17°");
  assert.equal(weatherDegrees(17.5), "18°");
  assert.equal(weatherDegrees(-3.2), "-3°");
  // Just under zero rounds to zero, not to "-0".
  assert.equal(weatherDegrees(-0.2), "0°");
  assert.equal(weatherDegrees(0), "0°");
  assert.equal(weatherDegrees(NaN), "");
  assert.equal(weatherDegrees(undefined), "");
});
