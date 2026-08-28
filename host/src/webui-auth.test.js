import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ensureWebUiAuth,
  isLoopbackBind,
  readWebUiAuthConfig,
  readWebUiAuthFile,
  webUiAuthPath,
  writeWebUiAuthConfig,
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

test("user can change the token and disable remote auth", () => {
  const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-auth-"));
  try {
    const initial = ensureWebUiAuth({}, "100.64.1.2", dir);
    const changed = writeWebUiAuthConfig(dir, { token: "user-token-1234567890" });
    assert.deepEqual(changed, { token: "user-token-1234567890", enabled: true });
    assert.deepEqual(readWebUiAuthConfig(dir), { token: "user-token-1234567890", enabled: true });
    assert.equal(initial.token === changed.token, false);

    const disabled = writeWebUiAuthConfig(dir, { enabled: false });
    assert.deepEqual(disabled, { token: "user-token-1234567890", enabled: false });
    assert.deepEqual(ensureWebUiAuth({}, "100.64.1.2", dir), {
      authRequired: false,
      token: "user-token-1234567890",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeWebUiAuthConfig rejects invalid tokens when enabling auth", () => {
  const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-auth-"));
  try {
    assert.throws(() => writeWebUiAuthConfig(dir, { token: "short" }), /token must be/);
    assert.throws(() => writeWebUiAuthConfig(dir, { enabled: true }), /token is required/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
