import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  codexResetAutoConsumeWindowMs,
  loadCodexBarConfig,
  DEFAULT_CODEX_RESET_AUTO_CONSUME_WINDOW_HOURS,
  MAX_CODEX_RESET_AUTO_CONSUME_WINDOW_HOURS,
  type CodexBarConfig,
} from "./codexbar-config";

const defaultWindowMs = DEFAULT_CODEX_RESET_AUTO_CONSUME_WINDOW_HOURS * 60 * 60 * 1000;
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("codexResetAutoConsumeWindowMs", () => {
  it.each([undefined, true, null, "false"])("defaults to enabled for missing or malformed flag %s", (flag) => {
    expect(codexResetAutoConsumeWindowMs({ codexResetAutoConsume: flag } as CodexBarConfig)).toBe(defaultWindowMs);
  });

  it("respects an explicit boolean false", () => {
    expect(codexResetAutoConsumeWindowMs({ codexResetAutoConsume: false })).toBeNull();
  });

  it("accepts a bounded positive custom window without an enable flag", () => {
    expect(codexResetAutoConsumeWindowMs({ codexResetAutoConsumeWindowHours: 12 })).toBe(12 * 60 * 60 * 1000);
    expect(codexResetAutoConsumeWindowMs({ codexResetAutoConsume: false, codexResetAutoConsumeWindowHours: 12 })).toBeNull();
    expect(codexResetAutoConsumeWindowMs({ codexResetAutoConsumeWindowHours: MAX_CODEX_RESET_AUTO_CONSUME_WINDOW_HOURS })).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, MAX_CODEX_RESET_AUTO_CONSUME_WINDOW_HOURS + 1, "12", null])("falls back to 24 hours for invalid window %s instead of disabling", (value) => {
    expect(codexResetAutoConsumeWindowMs({ codexResetAutoConsumeWindowHours: value } as CodexBarConfig)).toBe(defaultWindowMs);
  });

  it.each([undefined, "{broken", "null", "[]", '{"codexResetAutoConsume":true,"codexResetAutoConsumeWindowHours":0}'])("stays enabled after loading missing or malformed configuration %s", (contents) => {
    const root = mkdtempSync(join(tmpdir(), "codex-reset-config-"));
    dirs.push(root);
    vi.stubEnv("APPDATA", root);
    if (contents !== undefined) {
      const configDir = join(root, "CodexBar");
      mkdirSync(configDir);
      writeFileSync(join(configDir, "config.json"), contents, "utf8");
    }
    expect(codexResetAutoConsumeWindowMs(loadCodexBarConfig())).toBe(defaultWindowMs);
  });
});
