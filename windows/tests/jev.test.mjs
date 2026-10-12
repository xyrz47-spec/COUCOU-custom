// JEV's line on a permission card (src/core/jev.ts) and the card around it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
const { riskLine } = await import("../src/core/jev.ts");

const risk = (level, scope = "") => ({ level, destructive: 0, exfiltration: 0, scope, score: 0, confidence: 0.9 });

test("the line says how the request looks, then what it mainly does", () => {
  assert.equal(riskLine(risk("low")), "JEV: looks routine");
  assert.equal(riskLine(risk("medium", "run_code")), "JEV: worth reading before you allow · runs code");
  assert.equal(riskLine(risk("high", "system")), "JEV: could change or send things you may not want · touches the system");
  assert.equal(riskLine(risk("unsure", "teleport")), "JEV is not sure about this one", "an unknown scope adds nothing");
  assert.equal(riskLine({ ...risk("low"), level: "nonsense" }), "JEV is not sure about this one");
});

test("the permission card has no JEV line until JEV has answered", async () => {
  const { buildApproval } = await import("../src/views/views.ts");
  if (!buildApproval) return;
  const view = buildApproval({ blip() {}, decide() {}, foldApproval() {} });
  const lines = view.el.find(".jev-risk");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].style.display, "none");
});
