import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

test("ensureWebUiAuth enables remote auth and persists a generated token by default", () => {
  const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-auth-"));
  try {
    const result = ensureWebUiAuth({}, "100.64.1.2", dir);
    assert.equal(result.authRequired, true);
    assert.match(result.token, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(readWebUiAuthConfig(dir), { token: result.token, enabled: true });
    assert.deepEqual(ensureWebUiAuth({}, "100.64.1.2", dir), result);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rewriting auth config repairs POSIX file permissions", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-auth-"));
  try {
    const file = webUiAuthPath(dir);
    writeFileSync(file, '{"token":"old-token"}\n', { mode: 0o644 });
    chmodSync(file, 0o644);
    writeWebUiAuthConfig(dir, { token: "new-token" });
    assert.equal(statSync(file).mode & 0o777, 0o600);
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

test("ensureWebUiAuth persists a generated token after an env token is removed", () => {
  const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-auth-"));
  try {
    const envToken = "environment-token-1234567890";
    const managed = ensureWebUiAuth({ LEAFCODE_PI_WEBUI_TOKEN: envToken }, "100.64.1.2", dir);
    assert.deepEqual(managed, { authRequired: true, token: envToken });
    assert.deepEqual(readWebUiAuthConfig(dir), { token: null, enabled: true });

    const generated = ensureWebUiAuth({}, "100.64.1.2", dir);
    assert.equal(generated.authRequired, true);
    assert.notEqual(generated.token, envToken);
    assert.deepEqual(readWebUiAuthConfig(dir), { token: generated.token, enabled: true });
    assert.deepEqual(ensureWebUiAuth({}, "100.64.1.2", dir), generated);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("user can change the token and explicitly disable remote auth", () => {
  const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-auth-"));
  try {
    const initial = ensureWebUiAuth({}, "100.64.1.2", dir);
    assert.equal(initial.authRequired, true);
    const changed = writeWebUiAuthConfig(dir, { token: "abcd", enabled: false });
    assert.deepEqual(changed, { token: "abcd", enabled: false });
    assert.deepEqual(readWebUiAuthConfig(dir), { token: "abcd", enabled: false });

    assert.deepEqual(ensureWebUiAuth({}, "100.64.1.2", dir), {
      authRequired: false,
      token: "abcd",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeWebUiAuthConfig rejects invalid tokens when enabling auth", () => {
  const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-auth-"));
  try {
    assert.throws(() => writeWebUiAuthConfig(dir, { token: "abc" }), /token must be/);
    assert.throws(() => writeWebUiAuthConfig(dir, { enabled: true }), /token is required/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
