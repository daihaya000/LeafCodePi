import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ensureWebUiAuth,
  isLoopbackBind,
  readWebUiAuthFile,
  webUiAuthPath,
  writeWebUiAuthFile,
} from "./webui-auth.js";

test("isLoopbackBind recognizes loopback hosts", () => {
  assert.equal(isLoopbackBind("127.0.0.1"), true);
  assert.equal(isLoopbackBind("localhost"), true);
  assert.equal(isLoopbackBind("::1"), true);
  assert.equal(isLoopbackBind("100.64.1.2"), false);
  assert.equal(isLoopbackBind("0.0.0.0"), false);
});

test("ensureWebUiAuth skips auth on loopback", () => {
  const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-auth-"));
  try {
    const result = ensureWebUiAuth({}, "127.0.0.1", dir);
    assert.equal(result.authRequired, false);
    assert.equal(result.token, null);
    assert.equal(readWebUiAuthFile(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureWebUiAuth creates and persists token for remote bind", () => {
  const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-auth-"));
  try {
    const result = ensureWebUiAuth({}, "100.64.1.2", dir);
    assert.equal(result.authRequired, true);
    assert.ok(result.token && result.token.length >= 16);
    assert.equal(readWebUiAuthFile(dir), result.token);
    assert.deepEqual(JSON.parse(readFileSync(webUiAuthPath(dir), "utf8")), { token: result.token });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureWebUiAuth prefers env token", () => {
  const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-auth-"));
  try {
    writeWebUiAuthFile(dir, "stored-token-1234567890");
    const result = ensureWebUiAuth({ LEAFCODE_PI_WEBUI_TOKEN: "env-token-1234567890" }, "0.0.0.0", dir);
    assert.equal(result.token, "env-token-1234567890");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
