import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import {
  PERMISSION_GATE_SESSION_KEY,
  applyPermissionMode,
  permissionGateConfigPath,
  readPermissionGateConfig,
  writePermissionGateConfig,
} from "./permission-gate-config";

describe("permission-gate-config", () => {
  it("writes mode to .pi/leafcode/permission-gate.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "lcp-perm-"));
    try {
      writePermissionGateConfig(dir, "deny");
      const raw = readFileSync(permissionGateConfigPath(dir), "utf8");
      assert.deepEqual(JSON.parse(raw), { mode: "deny" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults to allow when no mode is persisted", () => {
    const dir = mkdtempSync(join(tmpdir(), "lcp-perm-"));
    try {
      assert.equal(readPermissionGateConfig(dir), "allow");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads persisted mode without writing", () => {
    const dir = mkdtempSync(join(tmpdir(), "lcp-perm-"));
    try {
      writePermissionGateConfig(dir, "deny");
      assert.equal(readPermissionGateConfig(dir), "deny");
      applyPermissionMode({ extensionRunner: undefined }, dir, "ask", { persist: false });
      const raw = readFileSync(permissionGateConfigPath(dir), "utf8");
      assert.equal(JSON.parse(raw).mode, "deny");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("updates live extension session context", () => {
    const dir = mkdtempSync(join(tmpdir(), "lcp-perm-"));
    const ctx: Record<string, unknown> = {};
    try {
      applyPermissionMode(
        { extensionRunner: { createContext: () => ctx } },
        dir,
        "allow",
      );
      assert.equal(ctx[PERMISSION_GATE_SESSION_KEY], "allow");
      const raw = readFileSync(permissionGateConfigPath(dir), "utf8");
      assert.equal(JSON.parse(raw).mode, "allow");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
