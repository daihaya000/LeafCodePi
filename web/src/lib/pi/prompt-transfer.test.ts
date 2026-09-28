import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportPromptBackup, importPromptBackup } from "./prompt-transfer";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "leafcode-prompts-transfer-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
  vi.stubEnv("LEAFCODE_PI_DATA_DIR", join(root, "data"));
  mkdirSync(join(root, "agent"));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

const file = (name: string) => join(root, "agent", name);
const archive = (files: Record<string, unknown>) => ({
  format: "leafcode-pi-prompts", version: 1, exportedAt: "2026-09-28T00:00:00.000Z", files,
});

describe("prompt transfer", () => {
  it("exports only existing files and imports only selected names", async () => {
    writeFileSync(file("USER.md"), "ユーザー😊\n", "utf8");
    writeFileSync(file("SOUL.md"), "old soul", "utf8");
    const backup = exportPromptBackup();
    expect(backup.files).toEqual({ "USER.md": "ユーザー😊\n", "SOUL.md": "old soul" });
    expect(backup.files["BOTS.md"]).toBeUndefined();
    writeFileSync(file("USER.md"), "new user");
    writeFileSync(file("SOUL.md"), "new soul");
    expect(await importPromptBackup(backup, ["USER.md"])).toEqual(["USER.md"]);
    expect(readFileSync(file("USER.md"), "utf8")).toBe("ユーザー😊\n");
    expect(readFileSync(file("SOUL.md"), "utf8")).toBe("new soul");
    expect(exportPromptBackup().files["BOTS.md"]).toBeUndefined();
  });

  it("validates the whole archive and selected names before writing", async () => {
    writeFileSync(file("USER.md"), "keep");
    const cases: Array<[unknown, unknown]> = [
      [archive({ "USER.md": "replace", "auth.json": "secret" }), ["USER.md"]],
      [archive({ "USER.md": "replace", "SOUL.md": "x".repeat(2 * 1024 * 1024 + 1) }), ["USER.md"]],
      [archive({ "USER.md": "replace" }), ["BOTS.md"]],
      [archive({ "USER.md": "replace" }), ["USER.md", "USER.md"]],
      [archive({ "USER.md": "replace" }), []],
    ];
    for (const [raw, selected] of cases) {
      await expect(importPromptBackup(raw, selected)).rejects.toThrow();
      expect(readFileSync(file("USER.md"), "utf8")).toBe("keep");
    }
  });

  it("restores existing and newly created files when a later write fails", async () => {
    writeFileSync(file("USER.md"), "original");
    let count = 0;
    await expect(importPromptBackup(archive({ "USER.md": "changed", "SOUL.md": "new" }),
      ["USER.md", "SOUL.md"], () => { if (++count === 2) throw new Error("disk failure"); }))
      .rejects.toThrow("disk failure");
    expect(readFileSync(file("USER.md"), "utf8")).toBe("original");
    expect(exportPromptBackup().files["SOUL.md"]).toBeUndefined();
  });

  it("rejects a directory destination before changing other files", async () => {
    writeFileSync(file("USER.md"), "keep");
    mkdirSync(file("SOUL.md"));
    await expect(importPromptBackup(archive({ "USER.md": "change", "SOUL.md": "new" }),
      ["USER.md", "SOUL.md"])).rejects.toThrow();
    expect(readFileSync(file("USER.md"), "utf8")).toBe("keep");
  });
});
