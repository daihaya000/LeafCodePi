import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BACKEND_HANG_STRIKE_LIMIT,
  backendHangShouldRestart,
  nextBackendHangStrikes,
} from "./backend-hang-watch.js";

test("ready health clears hang strikes", () => {
  assert.equal(nextBackendHangStrikes(2, { ok: true, ready: true }), 0);
});

test("timeout and unreachable accumulate toward a restart", () => {
  let strikes = 0;
  strikes = nextBackendHangStrikes(strikes, { ok: false, reason: "timeout" });
  strikes = nextBackendHangStrikes(strikes, { ok: false, reason: "unreachable" });
  assert.equal(strikes, 2);
  strikes = nextBackendHangStrikes(strikes, { ok: false, reason: "timeout" });
  assert.equal(backendHangShouldRestart(strikes), true);
  assert.equal(BACKEND_HANG_STRIKE_LIMIT, 3);
});

test("auth failures do not spend the hang budget", () => {
  assert.equal(nextBackendHangStrikes(2, { ok: false, reason: "unauthorized" }), 0);
  assert.equal(backendHangShouldRestart(2), false);
});
