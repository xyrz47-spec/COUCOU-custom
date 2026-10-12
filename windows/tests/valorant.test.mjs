// Settings → Valorant (src/settings/valorant.ts): the clock a moment is shown at.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
const { clockText } = await import("../src/settings/valorant.ts");

test("a moment in the video is written as m:ss", () => {
  assert.equal(clockText(0), "0:00");
  assert.equal(clockText(59_999), "0:59");
  assert.equal(clockText(61_000), "1:01");
  assert.equal(clockText(-5), "0:00");
});
