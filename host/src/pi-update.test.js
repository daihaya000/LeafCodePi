import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { autoUpdatePi, autoUpdatePiInBackground, PI_PACKAGE_NAME, PI_UPDATE_TIMEOUT_MS } from "./pi-update.js";

function makeWebDir(version) {
  const webDir = mkdtempSync(join(tmpdir(), "leafcode-pi-update-"));
  const packageDir = join(webDir, "node_modules", ...PI_PACKAGE_NAME.split("/"));
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ version }), "utf8");
  return webDir;
}

test("autoUpdatePi updates the embedded Pi package once", () => {
  const webDir = makeWebDir("0.84.4");
  const calls = [];
  const logs = [];
  try {
    const result = autoUpdatePi({
      webDir,
      platform: "win32",
      spawnSync: (command, args, options) => {
        calls.push({ command, args, options });
        const packageJson = join(webDir, "node_modules", ...PI_PACKAGE_NAME.split("/"), "package.json");
        writeFileSync(packageJson, JSON.stringify({ version: "0.85.0" }), "utf8");
        return { status: 0 };
      },
      log: (message) => logs.push(message),
    });

    assert.equal(result.attempted, true);
    assert.equal(result.updated, true);
    assert.equal(result.version, "0.85.0");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "npm.cmd");
    assert.deepEqual(calls[0].args, ["update", PI_PACKAGE_NAME, "--no-audit", "--no-fund"]);
    assert.equal(calls[0].options.cwd, webDir);
    assert.deepEqual(calls[0].options.stdio, ["ignore", "pipe", "pipe"]);
    assert.equal(calls[0].options.timeout, PI_UPDATE_TIMEOUT_MS);
    assert.deepEqual(logs, ["Pi updated from v0.84.4 to v0.85.0"]);
  } finally {
    rmSync(webDir, { recursive: true, force: true });
  }
});

test("autoUpdatePiInBackground updates without blocking startup", () => {
  const webDir = makeWebDir("0.84.4");
  const calls = [];
  const logs = [];
  const handlers = {};
  try {
    const result = autoUpdatePiInBackground({
      webDir,
      platform: "win32",
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        return {
          once: (event, handler) => {
            handlers[event] = handler;
          },
          unref: () => {},
        };
      },
      log: (message) => logs.push(message),
    });

    assert.deepEqual(result, { attempted: true, skipped: false });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "npm.cmd");
    assert.deepEqual(calls[0].args, ["update", PI_PACKAGE_NAME, "--no-audit", "--no-fund"]);
    assert.equal(calls[0].options.cwd, webDir);
    const packageJson = join(webDir, "node_modules", ...PI_PACKAGE_NAME.split("/"), "package.json");
    writeFileSync(packageJson, JSON.stringify({ version: "0.85.0" }), "utf8");
    handlers.close(0);
    assert.deepEqual(logs, ["Pi updated from v0.84.4 to v0.85.0"]);
  } finally {
    rmSync(webDir, { recursive: true, force: true });
  }
});

test("autoUpdatePiInBackground respects the opt-out flag", () => {
  const webDir = makeWebDir("0.84.4");
  try {
    let spawned = false;
    const result = autoUpdatePiInBackground({
      webDir,
      env: { LEAFCODE_PI_AUTO_UPDATE: "0" },
      spawn: () => {
        spawned = true;
      },
    });
    assert.deepEqual(result, { attempted: false, skipped: true });
    assert.equal(spawned, false);
  } finally {
    rmSync(webDir, { recursive: true, force: true });
  }
});

test("autoUpdatePi keeps startup usable when npm fails", () => {
  const webDir = makeWebDir("0.84.4");
  const errors = [];
  try {
    const result = autoUpdatePi({
      webDir,
      spawnSync: () => ({ status: 1 }),
      error: (message) => errors.push(message),
    });

    assert.deepEqual(result, { attempted: true, updated: false, skipped: false });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /continuing with the installed version/);
  } finally {
    rmSync(webDir, { recursive: true, force: true });
  }
});
