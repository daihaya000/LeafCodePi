import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LEAFCODE_MEMORY_SETTINGS,
  leafCodeMemoryConfigPath,
  leafCodeMemoryDir,
  readLeafCodeMemorySettings,
  writeLeafCodeMemorySettings,
} from "@/lib/leafcode-memory-settings";

let agentDir = "";
let env: Record<string, string | undefined>;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "leafcode-memory-settings-"));
  env = { PI_CODING_AGENT_DIR: agentDir };
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

describe("leafcode-memory settings", () => {
  it("returns editable defaults when the config does not exist", () => {
    expect(readLeafCodeMemorySettings(env)).toMatchObject({
      settings: DEFAULT_LEAFCODE_MEMORY_SETTINGS,
      exists: false,
      valid: true,
      writable: true,
    });
    expect(leafCodeMemoryDir(env)).toBe(join(agentDir, "leafcode-memory"));
  });

  it("writes validated parameters without losing file-only settings", () => {
    const path = leafCodeMemoryConfigPath(env);
    writeFileSync(path, JSON.stringify({
      memoryDir: "custom-memory",
      correctionStrongPatterns: ["keep-me"],
      sessionSearch: { variant: "legacy", futureOption: true },
    }), "utf8");

    const settings = {
      ...DEFAULT_LEAFCODE_MEMORY_SETTINGS,
      memoryMode: "legacy-inject" as const,
      memoryOverflowStrategy: "reject" as const,
      sessionSearchVariant: "anchors" as const,
    };
    const snapshot = writeLeafCodeMemorySettings(settings, env);
    const saved = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

    expect(snapshot.settings).toEqual(settings);
    expect(saved.memoryDir).toBe("custom-memory");
    expect(leafCodeMemoryDir(env)).toBe(join(agentDir, "custom-memory"));
    expect(saved.correctionStrongPatterns).toEqual(["keep-me"]);
    expect(saved.sessionSearch).toEqual({ variant: "anchors", futureOption: true });
    expect(saved.autoConsolidate).toBe(false);
    expect(readFileSync(path).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
  });

  it("refuses malformed source JSON and out-of-range input", () => {
    const path = leafCodeMemoryConfigPath(env);
    writeFileSync(path, "{broken", "utf8");

    expect(readLeafCodeMemorySettings(env)).toMatchObject({ valid: false, writable: false });
    expect(() => writeLeafCodeMemorySettings(DEFAULT_LEAFCODE_MEMORY_SETTINGS, env)).toThrow(/JSON/);

    writeFileSync(path, "{}", "utf8");
    expect(() => writeLeafCodeMemorySettings({
      ...DEFAULT_LEAFCODE_MEMORY_SETTINGS,
      memoryCharLimit: -1,
    }, env)).toThrow(/memoryCharLimit/);
  });
});
