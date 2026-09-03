import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeHangTimeoutSettingMs } from "@/lib/pi/hang-settings";
import { setSetting } from "@/lib/pi/web-settings";

const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;

describe("web-settings persistence", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "leafcode-web-settings-"));
    process.env.LEAFCODE_PI_DATA_DIR = root;
  });

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
    else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  });

  it("preserves updates from both settings writers without temporary files", () => {
    setSetting("auto-route-overrides", '{"version":2,"modes":{}}');
    writeHangTimeoutSettingMs(120_000);

    const saved = JSON.parse(readFileSync(join(root, "web-settings.json"), "utf8"));
    expect(saved["auto-route-overrides"]).toBe('{"version":2,"modes":{}}');
    expect(saved["hang-timeout"]).toBe(120_000);
    expect(readdirSync(root)).toEqual(["web-settings.json"]);
  });
});
