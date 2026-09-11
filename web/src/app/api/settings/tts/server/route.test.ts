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

import { DELETE, GET, POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.spawn.mockReturnValue({ unref: vi.fn() });
});

/** Fake child_process handle whose stdout emits `output` then closes. */
function stubCommand(output: string) {
  mocks.spawn.mockImplementation(() => ({
    unref: vi.fn(),
    stdout: {
      on: (_event: string, handler: (chunk: string) => void) => handler(output),
    },
    on: (event: string, handler: () => void) => {
      if (event === "close") handler();
    },
  }));
}

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

  it("starts the script in its own console so the tray survives", async () => {
    if (process.platform !== "win32") return;
    mocks.bundledExtensionsDir.mockReturnValue("C:/repo/extensions");
    mocks.existsSync.mockReturnValue(true);
    await expect((await POST()).json()).resolves.toMatchObject({ started: true });
    const [command, args, options] = mocks.spawn.mock.calls[0] as [string, string[], Record<string, unknown>];
    // Spawning powershell.exe directly ties it to our console and it dies with the request.
    expect(command).toBe("cmd.exe");
    expect(args.slice(0, 2)).toEqual(["/c", "start"]);
    expect(args).toContain("powershell.exe");
    expect(options.windowsHide).toBe(true);
  });

  it("stops the listener on the configured port", async () => {
    if (process.platform !== "win32") return;
    mocks.readTtsConfig.mockReturnValue({
      enabled: true,
      voice: "ramuchi",
      rate: 0,
      url: "http://127.0.0.1:18080/v1/audio/speech",
    });
    stubCommand("STOPPED");
    await expect((await DELETE()).json()).resolves.toMatchObject({ stopped: true });
    const args = mocks.spawn.mock.calls[0]?.[1] as string[];
    expect(args.join(" ")).toContain("18080");
  });

  it("reports when nothing is listening", async () => {
    if (process.platform !== "win32") return;
    mocks.readTtsConfig.mockReturnValue({
      enabled: true,
      voice: "",
      rate: 0,
      url: "http://127.0.0.1:18080/v1/audio/speech",
    });
    stubCommand("NOT_RUNNING");
    await expect((await DELETE()).json()).resolves.toMatchObject({ stopped: false });
  });
});
