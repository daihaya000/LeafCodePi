import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import {
  applyPermissionMode,
  permissionGateConfigPath,
  readPermissionGateConfig,
  readSystemSafetyEnabled,
  readSystemSafetyLevel,
  writePermissionGateConfig,
  writeSystemSafetyEnabled,
  writeSystemSafetyLevel,
} from "./permission-gate-config";

function withTempDataDir<T>(run: (projectDir: string, appDir: string) => T): T {
  const projectDir = mkdtempSync(join(tmpdir(), "lcp-project-"));
  const appDir = mkdtempSync(join(tmpdir(), "lcp-data-"));
  const previous = process.env.LEAFCODE_PI_DATA_DIR;
  process.env.LEAFCODE_PI_DATA_DIR = appDir;
  try {
    return run(projectDir, appDir);
  } finally {
    if (previous === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
    else process.env.LEAFCODE_PI_DATA_DIR = previous;
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(appDir, { recursive: true, force: true });
  }
}

describe("permission-gate-config", () => {
  it("writes mode to app data without creating project .pi", () => {
    withTempDataDir((projectDir, appDir) => {
      writePermissionGateConfig("deny");
      const raw = readFileSync(permissionGateConfigPath(), "utf8");
      assert.deepEqual(JSON.parse(raw), { mode: "deny" });
      assert.equal(permissionGateConfigPath(), join(appDir, "permission-gate.json"));
      assert.equal(existsSync(join(projectDir, ".pi")), false);
    });
  });

  it("defaults to allow when no mode is persisted", () => {
    withTempDataDir(() => assert.equal(readPermissionGateConfig(), "allow"));
  });

  it("preserves a disabled system safety setting when the mode changes", () => {
    withTempDataDir(() => {
      writeFileSync(
        permissionGateConfigPath(),
        JSON.stringify({ mode: "allow", systemSafety: false }),
        "utf8",
      );
      writePermissionGateConfig("ask");
      assert.deepEqual(JSON.parse(readFileSync(permissionGateConfigPath(), "utf8")), {
        mode: "ask",
        systemSafety: "off",
      });
    });
  });

  it("reads and writes system safety levels independently of permission mode", () => {
    withTempDataDir(() => {
      assert.equal(readSystemSafetyLevel(), "off");
      assert.equal(readSystemSafetyEnabled(), false);
      writePermissionGateConfig("deny");
      assert.equal(writeSystemSafetyLevel("low"), "low");
      assert.equal(readSystemSafetyLevel(), "low");
      assert.equal(readPermissionGateConfig(), "deny");
      assert.deepEqual(JSON.parse(readFileSync(permissionGateConfigPath(), "utf8")), {
        mode: "deny",
        systemSafety: "low",
      });
      assert.equal(writeSystemSafetyEnabled(false), false);
      assert.equal(readSystemSafetyLevel(), "off");
      assert.equal(writeSystemSafetyEnabled(true), true);
      assert.equal(readSystemSafetyLevel(), "standard");
    });
  });

  it("migrates legacy boolean systemSafety values", () => {
    withTempDataDir(() => {
      writeFileSync(
        permissionGateConfigPath(),
        JSON.stringify({ mode: "allow", systemSafety: true }),
        "utf8",
      );
      assert.equal(readSystemSafetyLevel(), "standard");
      writeFileSync(
        permissionGateConfigPath(),
        JSON.stringify({ mode: "allow", systemSafety: false }),
        "utf8",
      );
      assert.equal(readSystemSafetyLevel(), "off");
    });
  });

  it("reads persisted mode without writing", () => {
    withTempDataDir(() => {
      writePermissionGateConfig("deny");
      assert.equal(readPermissionGateConfig(), "deny");
      applyPermissionMode({ extensionRunner: undefined }, "ask", { persist: false });
      const raw = readFileSync(permissionGateConfigPath(), "utf8");
      assert.equal(JSON.parse(raw).mode, "deny");
    });
  });

  it("persists mode to disk for the file-backed extension gate", () => {
    withTempDataDir(() => {
      applyPermissionMode({ extensionRunner: { createContext: () => ({}) } }, "deny");
      assert.equal(readPermissionGateConfig(), "deny");
      const raw = readFileSync(permissionGateConfigPath(), "utf8");
      assert.equal(JSON.parse(raw).mode, "deny");
    });
  });

  it("keeps per-session modes isolated from the default and each other", () => {
    withTempDataDir(() => {
      writePermissionGateConfig("allow");
      applyPermissionMode({ sessionId: "task-a" }, "deny");
      applyPermissionMode({ sessionManager: { getSessionId: () => "task-b" } }, "ask");

      assert.equal(readPermissionGateConfig(), "allow");
      assert.equal(readPermissionGateConfig("task-a"), "deny");
      assert.equal(readPermissionGateConfig("task-b"), "ask");
      assert.equal(readPermissionGateConfig("task-c"), "allow");

      const raw = JSON.parse(readFileSync(permissionGateConfigPath(), "utf8")) as {
        mode: string;
        sessions: Record<string, string>;
      };
      assert.equal(raw.mode, "allow");
      assert.equal(raw.sessions["task-a"], "deny");
      assert.equal(raw.sessions["task-b"], "ask");

      writePermissionGateConfig("ask");
      assert.equal(readPermissionGateConfig(), "ask");
      assert.equal(readPermissionGateConfig("task-a"), "deny");
    });
  });

  it("rebinds a stored task mode onto a new session id after reopen", () => {
    withTempDataDir(() => {
      applyPermissionMode({ sessionId: "old-session" }, "deny");
      applyPermissionMode({ sessionId: "new-session" }, "deny");
      assert.equal(readPermissionGateConfig("new-session"), "deny");
      assert.equal(readPermissionGateConfig(), "allow");
    });
  });
});
