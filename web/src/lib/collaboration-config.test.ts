import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { readCollaborationConfig } from "./collaboration";

describe("readCollaborationConfig", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("defaults to strict when the user-owned config is absent", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "leafcode-collab-config-"));
    tempDirs.push(dataDir);
    assert.deepEqual(readCollaborationConfig({ ...process.env, LEAFCODE_PI_DATA_DIR: dataDir }), {
      config: { mode: "strict" },
      valid: true,
    });
  });

  it("fails closed on invalid configuration", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "leafcode-collab-config-"));
    tempDirs.push(dataDir);
    writeFileSync(join(dataDir, "collaboration.json"), JSON.stringify({ mode: "unsafe" }), "utf8");
    const result = readCollaborationConfig({ ...process.env, LEAFCODE_PI_DATA_DIR: dataDir });
    assert.equal(result.valid, false);
    assert.deepEqual(result.config, { mode: "strict" });
  });
});
