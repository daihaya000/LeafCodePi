import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMcpPresetRequest, publicMcpReload } from "./mcp-preset-request.mjs";

test("preset parser accepts exactly four request shapes, clones them and preserves internal credential input", () => {
  for (const input of [{ preset: "n8n", url: "example.invalid" }, { preset: "slack", clientId: "fixture-client" },
    { preset: "google-workspace", clientId: "fixture-client", clientSecret: "private-fixture-secret" }, { preset: "notion" }]) {
    const result = parseMcpPresetRequest(input);
    assert.deepEqual(result, { ok: true, value: input });
    assert.notEqual(result.value, input);
  }
});

test("preset parser rejects missing, non-own and privileged fields without echoing values", () => {
  for (const input of [null, [], {}, { preset: "unknown" }, { preset: "__proto__" }, { preset: "constructor" },
    { preset: "n8n" }, { preset: "slack", clientId: " " }, { preset: "google-workspace", clientId: "x", clientSecret: 42 },
    { preset: "notion", configPath: "private-fixture-secret" }, { preset: "n8n", url: "example.invalid", command: "run" },
    Object.create({ preset: "notion" }), Object.assign(Object.create({ clientId: "x" }), { preset: "slack" })]) {
    assert.deepEqual(parseMcpPresetRequest(input), { ok: false });
  }
});

test("reload summary validates counters and redacts all error/extra fields", () => {
  const input = { reloaded: 1, deferred: 2, failed: 1, errors: ["private-fixture-secret"], configPath: "owner-private-path" };
  assert.deepEqual(publicMcpReload(input), { reloaded: 1, deferred: 2, failed: 1,
    errors: ["セッションの再読込に失敗しました"] });
  assert.equal(input.errors[0], "private-fixture-secret");
  for (const value of [null, {}, { ...input, failed: -1 }, { ...input, failed: NaN }, { ...input, reloaded: "1" },
    { ...input, deferred: Infinity }, { ...input, errors: "private-fixture-secret" }]) assert.equal(publicMcpReload(value), null);
});
