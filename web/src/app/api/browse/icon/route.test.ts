import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execFile: vi.fn() }));

vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));

import { ICON_FILE_ERROR } from "@/lib/icon-file";
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
    const encoded = mocks.execFile.mock.calls[0]?.[1]?.[3] as string;
    const script = Buffer.from(encoded, "base64").toString("utf16le");
    expect(script).toContain("*.exe");
    expect(script).toContain("ExtractAssociatedIcon");
  });

  it.skipIf(windowsOnly)("reports a dismissed dialog without an icon", async () => {
    dialogResult("");

    const response = await POST(request({ path: dir }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cancelled: true });
  });

  it.skipIf(windowsOnly)("returns an icon extracted from a picked executable", async () => {
    dialogResult(JSON.stringify({ kind: "icon", name: "app.exe", base64: "AAABAA==" }));

    const response = await POST(request({ path: dir }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      icon: "data:image/x-icon;base64,AAABAA==",
      name: "app.exe",
    });
  });

  it.skipIf(windowsOnly)("reports an executable without an extractable icon", async () => {
    dialogResult(JSON.stringify({ kind: "error" }));

    const response = await POST(request({ path: dir }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "EXEからアイコンを取得できませんでした。" });
  });

  it.skipIf(windowsOnly)("rejects a picked file that is not an icon image", async () => {
    dialogResult(join(dir, "notes.txt"));

    const response = await POST(request({ path: dir }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: ICON_FILE_ERROR });
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
