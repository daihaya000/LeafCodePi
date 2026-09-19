import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execFile: vi.fn() }));

vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));

import { POST } from "./route";

const dir = mkdtempSync(join(tmpdir(), "leafcode-icon-route-"));
const iconPath = join(dir, "app.ico");
writeFileSync(iconPath, Buffer.from([0, 0, 1, 0]));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/browse/icon", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** PowerShell の代わりにダイアログの選択結果（標準出力）だけを返す。 */
function dialogResult(stdout: string): void {
  mocks.execFile.mockImplementation(
    (_command: string, _args: string[], _options: unknown, callback: (error: unknown, result: { stdout: string }) => void) => {
      callback(null, { stdout });
    },
  );
}

const windowsOnly = process.platform !== "win32";

describe("POST /api/browse/icon", () => {
  beforeEach(() => {
    mocks.execFile.mockReset();
  });

  it.skipIf(windowsOnly)("starts the dialog in the given folder and returns the picked icon", async () => {
    dialogResult(iconPath);

    const response = await POST(request({ path: dir }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      icon: "data:image/x-icon;base64,AAABAA==",
      name: "app.ico",
    });
    expect(mocks.execFile).toHaveBeenCalledWith(
      "powershell.exe",
      ["-NoProfile", "-STA", "-EncodedCommand", expect.any(String)],
      expect.objectContaining({ env: expect.objectContaining({ LEAFCODE_PI_ICON_DIR: dir }) }),
      expect.any(Function),
    );
  });

  it.skipIf(windowsOnly)("reports a dismissed dialog without an icon", async () => {
    dialogResult("");

    const response = await POST(request({ path: dir }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cancelled: true });
  });

  it.skipIf(windowsOnly)("rejects a picked file that is not an icon image", async () => {
    dialogResult(join(dir, "notes.txt"));

    const response = await POST(request({ path: dir }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "PNG・JPEG・GIF・WebP・ICO の画像を選択してください。" });
  });

  it.skipIf(windowsOnly)("reports a dialog failure as a server error", async () => {
    mocks.execFile.mockImplementation(
      (_command: string, _args: string[], _options: unknown, callback: (error: unknown) => void) => {
        callback(new Error("spawn failed"));
      },
    );

    const response = await POST(request({ path: dir }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "spawn failed" });
  });

  it.skipIf(windowsOnly)("falls back to the default folder when the start path is not a directory", async () => {
    dialogResult("");

    const response = await POST(request({ path: join(dir, "missing") }));

    expect(response.status).toBe(200);
    expect(mocks.execFile).toHaveBeenCalledWith(
      "powershell.exe",
      expect.any(Array),
      expect.objectContaining({ env: expect.objectContaining({ LEAFCODE_PI_ICON_DIR: "" }) }),
      expect.any(Function),
    );
  });
});
