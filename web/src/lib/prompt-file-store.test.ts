import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promptFileStoreDir, readStoredPromptFileContent, storePromptFileContent } from "./prompt-file-store";

describe("prompt file store", () => {
  let root: string;
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env.LEAFCODE_PI_DATA_DIR;
    root = mkdtempSync(join(tmpdir(), "leafcode-prompt-files-"));
    process.env.LEAFCODE_PI_DATA_DIR = root;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
    else process.env.LEAFCODE_PI_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });

  it("round-trips stored text inside the data directory", () => {
    const path = storePromptFileContent({ name: "../evil:name.txt", mimeType: "text/plain", data: "" }, "\u65e5\u672c\u8a9e");
    expect(path.startsWith(promptFileStoreDir())).toBe(true);
    expect(path.endsWith("evil_name.txt")).toBe(true);
    expect(readStoredPromptFileContent(path)).toBe("\u65e5\u672c\u8a9e");
  });

  it("refuses paths outside the store", () => {
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "secret");
    expect(readStoredPromptFileContent(outside)).toBeNull();
    expect(readStoredPromptFileContent(join(promptFileStoreDir(), "..", "outside.txt"))).toBeNull();
  });
});
