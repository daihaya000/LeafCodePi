import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ICON_FILE_ERROR, MAX_ICON_FILE_BYTES, readIconFileAsDataUrl } from "@/lib/icon-file";

const dir = mkdtempSync(join(tmpdir(), "leafcode-icon-file-"));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function file(name: string, bytes: Buffer | string): string {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

describe("readIconFileAsDataUrl", () => {
  it("converts ICO and case-insensitive raster extensions into icon data URLs", () => {
    expect(readIconFileAsDataUrl(file("app.ico", Buffer.from([0, 0, 1, 0])))).toEqual({
      ok: true,
      icon: "data:image/x-icon;base64,AAABAA==",
      name: "app.ico",
    });
    expect(readIconFileAsDataUrl(file("App.PNG", Buffer.from([137, 80, 78, 71])))).toEqual({
      ok: true,
      icon: "data:image/png;base64,iVBORw==",
      name: "App.PNG",
    });
  });

  it("rejects unsupported extensions, directories, oversized files and missing paths", () => {
    mkdirSync(join(dir, "folder.png"));
    expect(readIconFileAsDataUrl(file("icon.svg", "<svg/>"))).toEqual({
      ok: false,
      error: ICON_FILE_ERROR,
    });
    expect(readIconFileAsDataUrl(join(dir, "folder.png"))).toEqual({
      ok: false,
      error: "ファイルを選択してください。",
    });
    expect(readIconFileAsDataUrl(file("large.png", Buffer.alloc(MAX_ICON_FILE_BYTES + 1)))).toEqual({
      ok: false,
      error: "2 MB以下の画像を選択してください。",
    });
    expect(readIconFileAsDataUrl(join(dir, "missing.png"))).toEqual({
      ok: false,
      error: "ファイルを読み込めませんでした。",
    });
  });
});
