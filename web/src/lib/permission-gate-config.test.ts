import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import {
  applyPermissionMode,
  permissionGateConfigPath,
  readPermissionGateConfig,
  writePermissionGateConfig,
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
});
