// The Menu tab (src/views/menu.ts): the names sent back so "Again" gives other dishes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
const { namesToAvoid } = await import("../src/views/menu.ts");

test("the dishes already shown are sent back once each, newest last, and capped", () => {
  const item = (name) => ({ name, why: "", tags: [] });
  assert.deepEqual(namesToAvoid([], [item("Udon"), item("Pho")]), ["Udon", "Pho"]);
  assert.deepEqual(namesToAvoid(["Udon"], [item("udon"), item("Soba")]), ["Udon", "Soba"], "a repeat in other letters is not added");
  const many = Array.from({ length: 30 }, (_, n) => item(`Dish ${n}`));
  const kept = namesToAvoid([], many, 20);
  assert.equal(kept.length, 20);
  assert.equal(kept.at(-1), "Dish 29");
});
