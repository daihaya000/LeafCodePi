import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "vitest";
import {
  COMMIT_GUARD_CONFIG_FILE,
  COMMIT_GUARD_EXTENSION_NAME,
  readCommitGuardEnabled,
  writeCommitGuardEnabled,
} from "./commit-guard-config";
import { extensionsStatePath } from "./extensions";

describe("commit-guard-config", () => {
  let previousDataDir: string | undefined;
  let data: string;

  beforeEach(() => {
    previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
    data = mkdtempSync(join(tmpdir(), "leafcode-commit-guard-cfg-"));
    process.env.LEAFCODE_PI_DATA_DIR = data;
  });

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
    else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
    rmSync(data, { recursive: true, force: true });
  });

  it("defaults to enabled when no config exists", () => {
    assert.equal(readCommitGuardEnabled(), true);
  });

  it("persists the feature toggle without touching extension load state keys beyond cleanup", () => {
    assert.equal(writeCommitGuardEnabled(false), false);
    assert.equal(readCommitGuardEnabled(), false);
    const raw = JSON.parse(readFileSync(join(data, COMMIT_GUARD_CONFIG_FILE), "utf8")) as {
      enabled?: boolean;
    };
    assert.equal(raw.enabled, false);
    assert.equal(writeCommitGuardEnabled(true), true);
    assert.equal(readCommitGuardEnabled(), true);
  });

  it("writes atomically into a missing data dir and leaves no temp file", () => {
    process.env.LEAFCODE_PI_DATA_DIR = join(data, "nested", "missing");
    assert.equal(writeCommitGuardEnabled(false), false);
    assert.equal(readCommitGuardEnabled(), false);
    const leftovers = readdirSync(join(data, "nested", "missing")).filter((name) =>
      name.endsWith(".tmp"),
    );
    assert.deepEqual(leftovers, []);
  });

  it("migrates a stale extension-disable flag into feature off", () => {
    writeFileSync(
      extensionsStatePath(data),
      `${JSON.stringify({ disabled: { [COMMIT_GUARD_EXTENSION_NAME]: true } }, null, 2)}\n`,
      "utf8",
    );
    assert.equal(readCommitGuardEnabled(), false);
    const state = JSON.parse(readFileSync(extensionsStatePath(data), "utf8")) as {
      disabled?: Record<string, true>;
    };
    assert.equal(state.disabled?.[COMMIT_GUARD_EXTENSION_NAME], undefined);
    assert.equal(readCommitGuardEnabled(), false);
  });
});
