import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execFile: vi.fn(), allowed: vi.fn() }));

vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));
vi.mock("@/lib/browse-paths", () => ({ isAllowedBrowsePath: mocks.allowed }));

import { ICON_FILE_ERROR } from "@/lib/icon-file";
import { GET, POST } from "./route";

const dir = mkdtempSync(join(tmpdir(), "leafcode-icon-route-"));
const iconPath = join(dir, "app.ico");
const exePath = join(dir, "tool.exe");
writeFileSync(iconPath, Buffer.from([0, 0, 1, 0]));
writeFileSync(exePath, "MZ");
writeFileSync(join(dir, "notes.txt"), "text");
writeFileSync(join(dir, ".hidden.png"), "x");
mkdirSync(join(dir, "assets"));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/browse/icon", { method: "POST", body: JSON.stringify(body) });
}

function list(path: string): NextRequest {
  return new NextRequest(`http://localhost/api/browse/icon?path=${encodeURIComponent(path)}`);
}

const windowsOnly = process.platform !== "win32";

describe("/api/browse/icon", () => {
  beforeEach(() => {
    mocks.execFile.mockReset();
    mocks.allowed.mockReset().mockReturnValue(true);
  });

  it("lists folders first, then icon candidates only", async () => {
    const response = await GET(list(dir));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.path).toBe(dir);
    expect(body.entries.map((entry: { name: string; kind: string }) => `${entry.kind}:${entry.name}`)).toEqual([
      "dir:assets",
      "file:app.ico",
      ...(process.platform === "win32" ? ["file:tool.exe"] : []),
    ]);
  });

  it("rejects folders outside the browse roots", async () => {
    mocks.allowed.mockReturnValue(false);

    expect((await GET(list(dir))).status).toBe(403);
    expect((await POST(post({ path: iconPath }))).status).toBe(403);
  });

  it("returns a picked image as a data URL", async () => {
    const response = await POST(post({ path: iconPath }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ icon: "data:image/x-icon;base64,AAABAA==", name: "app.ico" });
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it("rejects a file that is not an icon image", async () => {
    const response = await POST(post({ path: join(dir, "notes.txt") }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: ICON_FILE_ERROR });
  });

  it("rejects relative paths", async () => {
    expect((await POST(post({ path: "app.ico" }))).status).toBe(400);
  });

  it.skipIf(windowsOnly)("extracts a PNG icon from an executable without a dialog", async () => {
    mocks.execFile.mockImplementation(
      (_command: string, _args: string[], _options: unknown, callback: (error: unknown, result: { stdout: string }) => void) => {
        callback(null, { stdout: "iVBORw==" });
      },
    );

    const response = await POST(post({ path: exePath }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ icon: "data:image/png;base64,iVBORw==", name: "tool.exe" });
    expect(mocks.execFile).toHaveBeenCalledWith(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", expect.any(String)],
      expect.objectContaining({ windowsHide: true, env: expect.objectContaining({ LEAFCODE_PI_ICON_FILE: exePath }) }),
      expect.any(Function),
    );
    const encoded = mocks.execFile.mock.calls[0]?.[1]?.[3] as string;
    const script = Buffer.from(encoded, "base64").toString("utf16le");
    expect(script).toContain("ExtractAssociatedIcon");
    expect(script).not.toContain("OpenFileDialog");
  });

  it.skipIf(windowsOnly)("reports an executable without an extractable icon", async () => {
    mocks.execFile.mockImplementation(
      (_command: string, _args: string[], _options: unknown, callback: (error: unknown, result: { stdout: string }) => void) => {
        callback(null, { stdout: "" });
      },
    );

    const response = await POST(post({ path: exePath }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "EXEからアイコンを取得できませんでした。" });
  });
});
