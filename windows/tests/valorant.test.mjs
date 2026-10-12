// Settings → Valorant (src/settings/valorant.ts): the clock a moment is shown at.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
const { clockText } = await import("../src/settings/valorant.ts");
const { sizeText } = await import("../src/views/valorant.ts");

test("a moment in the video is written as m:ss", () => {
  assert.equal(clockText(0), "0:00");
  assert.equal(clockText(59_999), "0:59");
  assert.equal(clockText(61_000), "1:01");
  assert.equal(clockText(-5), "0:00");
});

test("pasted events are read, or refused with a reason", async () => {
  const { parseEvents } = await import("../src/settings/valorant.ts");
  const good = '{"videoMs": 60000, "events": [{"atMs": 2000, "kind": "death", "detail": "x"}]}';
  assert.equal(parseEvents(good).videoMs, 60000);
  assert.equal(typeof parseEvents("{oops"), "string");
  assert.equal(typeof parseEvents('{"videoMs": 5}'), "string");
  assert.equal(typeof parseEvents("null"), "string");
});

test("a recording's size is written in MB, or GB from one gigabyte", () => {
  assert.equal(sizeText(1), "1 MB");
  assert.equal(sizeText(150 * (1 << 20)), "150 MB");
  assert.equal(sizeText(3 * (1 << 29)), "1.5 GB");
});
