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
      // The suite may run inside a live Host (LEAFCODE_PI_AUTO_UPDATE=0): this test decides itself.
      env: {},
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
      env: {},
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

test("autoUpdatePiInBackground aligns a Backend SDK that is behind the WebUI install", () => {
  const webDir = makeWebDir("0.99.2");
  const backendDir = makeWebDir("0.87.1");
  const calls = [];
  const logs = [];
  const handlers = [];
  try {
    autoUpdatePiInBackground({
      webDir,
      backendDir,
      env: {},
      platform: "win32",
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        const own = {};
        handlers.push(own);
        return { once: (event, handler) => { own[event] = handler; }, unref: () => {} };
      },
      log: (message) => logs.push(message),
    });
    handlers[0].close(0);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].args, ["install", `${PI_PACKAGE_NAME}@0.99.2`, "--save-exact", "--no-audit", "--no-fund"]);
    assert.equal(calls[1].options.cwd, backendDir);
    handlers[1].close(0);
    assert.match(logs.at(-1), /Backend Pi SDK aligned from v0\.87\.1 to v0\.99\.2/);
  } finally {
    rmSync(webDir, { recursive: true, force: true });
    rmSync(backendDir, { recursive: true, force: true });
  }
});

test("autoUpdatePiInBackground leaves a matching or newer Backend SDK alone", () => {
  for (const [web, backend] of [["0.99.2", "0.99.2"], ["0.87.1", "0.99.2"], ["0.99.10", "0.99.9"]]) {
    const webDir = makeWebDir(web);
    const backendDir = makeWebDir(backend);
    const calls = [];
    const handlers = {};
    try {
      autoUpdatePiInBackground({
        webDir,
        backendDir,
        env: {},
        platform: "win32",
        spawn: (command, args) => {
          calls.push(args[0]);
          return { once: (event, handler) => { handlers[event] = handler; }, unref: () => {} };
        },
      });
      handlers.close(0);
      // Only a strictly newer WebUI SDK triggers an install: 0.99.10 beats 0.99.9 numerically.
      assert.deepEqual(calls, web === "0.99.10" ? ["update", "install"] : ["update"], `${web} vs ${backend}`);
    } finally {
      rmSync(webDir, { recursive: true, force: true });
      rmSync(backendDir, { recursive: true, force: true });
    }
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
      env: {},
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
