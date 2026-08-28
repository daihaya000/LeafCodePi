import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { DEFAULT_COLLABORATION_CONFIG, parseCheckArgs, readCollaborationConfig, writeCollaborationConfig } from "./collaboration";

describe("readCollaborationConfig", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("defaults to off when the user-owned config is absent", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "leafcode-collab-config-"));
    tempDirs.push(dataDir);
    assert.deepEqual(readCollaborationConfig({ ...process.env, LEAFCODE_PI_DATA_DIR: dataDir }), {
      config: DEFAULT_COLLABORATION_CONFIG,
      valid: true,
    });
  });

  it("fails closed on invalid configuration", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "leafcode-collab-config-"));
    tempDirs.push(dataDir);
    writeFileSync(join(dataDir, "collaboration.json"), JSON.stringify({ mode: "unsafe" }), "utf8");
    const result = readCollaborationConfig({ ...process.env, LEAFCODE_PI_DATA_DIR: dataDir });
    assert.equal(result.valid, false);
    assert.equal(result.config.mode, "off");
    assert.equal(result.config.heartbeatMs, 2_000);
  });

  it("uses defaults for omitted timing values and rejects unsafe values", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "leafcode-collab-config-"));
    tempDirs.push(dataDir);
    writeFileSync(join(dataDir, "collaboration.json"), JSON.stringify({ mode: "strict", leaseTtlMs: 100 }), "utf8");
    const result = readCollaborationConfig({ ...process.env, LEAFCODE_PI_DATA_DIR: dataDir });
    assert.equal(result.valid, false);
    assert.match(result.error ?? "", /invalid/);
  });

  it("keeps the fixed check registry while allowing user-owned argv overrides", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "leafcode-collab-config-"));
    tempDirs.push(dataDir);
    writeFileSync(join(dataDir, "collaboration.json"), JSON.stringify({
      mode: "strict",
      checks: { test: { file: "node", args: ["-e", "process.exit(0)"] } },
    }), "utf8");
    const result = readCollaborationConfig({ ...process.env, LEAFCODE_PI_DATA_DIR: dataDir });
    assert.equal(result.valid, true);
    assert.deepEqual(result.config.checks.test, { file: "node", args: ["-e", "process.exit(0)"] });
    assert.deepEqual(result.config.checks.typecheck, DEFAULT_COLLABORATION_CONFIG.checks.typecheck);

    writeFileSync(join(dataDir, "collaboration.json"), JSON.stringify({
      mode: "strict",
      checks: { unknown: { file: "node", args: [] } },
    }), "utf8");
    assert.equal(readCollaborationConfig({ ...process.env, LEAFCODE_PI_DATA_DIR: dataDir }).valid, false);
  });

  it("writes a validated config and refuses invalid values", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "leafcode-collab-config-"));
    tempDirs.push(dataDir);
    const env = { ...process.env, LEAFCODE_PI_DATA_DIR: dataDir };
    const written = writeCollaborationConfig({
      ...DEFAULT_COLLABORATION_CONFIG,
      mode: "permissive",
      heartbeatMs: 1_000,
      leaseTtlMs: 20_000,
    }, env);
    assert.equal(written.valid, true);
    assert.equal(written.exists, true);
    assert.equal(readCollaborationConfig(env).config.mode, "permissive");
    assert.equal(readCollaborationConfig(env).config.heartbeatMs, 1_000);

    const rejected = writeCollaborationConfig({ mode: "strict", leaseTtlMs: 100 }, env);
    assert.equal(rejected.valid, false);
    assert.equal(readCollaborationConfig(env).config.mode, "permissive");
  });

  it("accepts off mode", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "leafcode-collab-config-"));
    tempDirs.push(dataDir);
    const env = { ...process.env, LEAFCODE_PI_DATA_DIR: dataDir };
    const written = writeCollaborationConfig({ ...DEFAULT_COLLABORATION_CONFIG, mode: "off" }, env);
    assert.equal(written.valid, true);
    assert.equal(readCollaborationConfig(env).config.mode, "off");
  });
});

describe("parseCheckArgs", () => {
  it("parses whitespace, quotes, and JSON arrays", () => {
    assert.deepEqual(parseCheckArgs("--prefix web run typecheck"), ["--prefix", "web", "run", "typecheck"]);
    assert.deepEqual(parseCheckArgs(`"--prefix" "web app" run`), ["--prefix", "web app", "run"]);
    assert.deepEqual(parseCheckArgs('["--prefix","web","run","typecheck"]'), ["--prefix", "web", "run", "typecheck"]);
    assert.equal(parseCheckArgs('"unterminated'), undefined);
  });
});
