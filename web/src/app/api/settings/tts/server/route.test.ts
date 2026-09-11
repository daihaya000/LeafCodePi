import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  readTtsConfig: vi.fn(),
  bundledExtensionsDir: vi.fn(),
  existsSync: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("@/lib/tts-config", () => ({ readTtsConfig: mocks.readTtsConfig }));
vi.mock("@/lib/extensions", () => ({ bundledExtensionsDir: mocks.bundledExtensionsDir }));
vi.mock("node:fs", () => ({ existsSync: mocks.existsSync }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));

import { GET, POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.spawn.mockReturnValue({ unref: vi.fn() });
});

describe("tts server route", () => {
  it("reports not running without a URL", async () => {
    mocks.readTtsConfig.mockReturnValue({ enabled: true, voice: "", rate: 0, url: "" });
    await expect((await GET()).json()).resolves.toMatchObject({ running: false });
  });

  it("probes /v1/health derived from the configured URL", async () => {
    mocks.readTtsConfig.mockReturnValue({
      enabled: true,
      voice: "ramuchi",
      rate: 0,
      url: "http://127.0.0.1:18080/v1/audio/speech",
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const body = await (await GET()).json();
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:18080/v1/health", expect.anything());
    expect(body).toMatchObject({ running: true });
    vi.unstubAllGlobals();
  });

  it("refuses to start when local.rocm.json is missing", async () => {
    if (process.platform !== "win32") return;
    mocks.bundledExtensionsDir.mockReturnValue("C:/repo/extensions");
    mocks.existsSync.mockImplementation((path: string) => path.endsWith("start-rocm.ps1"));
    const res = await POST();
    expect(res.status).toBe(400);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("spawns the startup script detached", async () => {
    if (process.platform !== "win32") return;
    mocks.bundledExtensionsDir.mockReturnValue("C:/repo/extensions");
    mocks.existsSync.mockReturnValue(true);
    await expect((await POST()).json()).resolves.toMatchObject({ started: true });
    expect(mocks.spawn).toHaveBeenCalledWith(
      "powershell.exe",
      expect.arrayContaining(["-File"]),
      expect.objectContaining({ detached: true }),
    );
  });
});
