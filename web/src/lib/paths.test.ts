import { describe, expect, it, afterEach, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  dataDir,
  displayLeafcodePiDataPath,
  noProjectRoot,
  noProjectSessionDir,
  resolveNoProjectRoot,
  sameOrDescendantPath,
  samePath,
  webUiAuthConfigPath,
} from "./paths";

const roots: string[] = [];

afterEach(() => {
  delete process.env.LEAFCODE_PI_DEFAULT_DIR;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("path identity", () => {
  it("preserves POSIX case and folds Windows case", () => {
    expect(samePath("/work/Foo", "/work/foo", "linux")).toBe(false);
    expect(samePath("C:\\work\\Foo", "c:\\WORK\\foo", "win32")).toBe(true);
  });

  it("checks descendants with platform path semantics", () => {
    expect(sameOrDescendantPath("/work/Foo/src", "/work/Foo", "linux")).toBe(true);
    expect(sameOrDescendantPath("/work/foo/src", "/work/Foo", "linux")).toBe(false);
  });
});

describe("live data guard", () => {
  it("refuses the real data directory during tests and accepts temp overrides", () => {
    vi.stubEnv("LEAFCODE_PI_DATA_DIR", "");
    vi.stubEnv("APPDATA", join("C:", "Users", "someone", "AppData", "Roaming"));
    expect(() => dataDir()).toThrow(/Refusing to use the live LeafCodePi directory/);
    vi.stubEnv("LEAFCODE_PI_DEFAULT_DIR", join("C:", "Users", "someone", "Documents", "LeafCodePi"));
    expect(() => noProjectRoot()).toThrow(/Refusing to use the live LeafCodePi directory/);

    const root = join(tmpdir(), `leafcode-pi-guard-${Date.now()}`);
    vi.stubEnv("LEAFCODE_PI_DATA_DIR", root);
    expect(dataDir()).toBe(root);
  });
});

describe("displayLeafcodePiDataPath", () => {
  it("shows the OS-correct default data path for users", () => {
    expect(displayLeafcodePiDataPath("webui-auth.json", "win32", "")).toBe(
      "%APPDATA%\\leafcode-pi\\webui-auth.json",
    );
    expect(displayLeafcodePiDataPath("webui-auth.json", "linux", "")).toBe(
      "~/.leafcode-pi/webui-auth.json",
    );
    expect(displayLeafcodePiDataPath("tts.json", "darwin", "")).toBe("~/.leafcode-pi/tts.json");
    expect(displayLeafcodePiDataPath("", "linux", "")).toBe("~/.leafcode-pi");
  });

  it("uses an explicit data-dir override when present", () => {
    expect(displayLeafcodePiDataPath("webui-auth.json", "linux", "/tmp/leafcode-data")).toBe(
      "/tmp/leafcode-data/webui-auth.json",
    );
    expect(displayLeafcodePiDataPath("webui-auth.json", "win32", "D:\\data\\leafcode-pi")).toBe(
      "D:\\data\\leafcode-pi\\webui-auth.json",
    );
  });

  it("joins webui-auth.json onto the resolved data directory", () => {
    expect(webUiAuthConfigPath()).toBe(join(dataDir(), "webui-auth.json"));
  });
});

describe("no-project workspace paths", () => {
  it("uses minute precision and adds seconds only after a collision", () => {
    const root = join(tmpdir(), `leafcode-pi-paths-${Date.now()}`);
    roots.push(root);
    process.env.LEAFCODE_PI_DEFAULT_DIR = root;
    const date = new Date(2025, 6, 14, 15, 30, 12);

    expect(noProjectRoot()).toBe(root);
    expect(noProjectSessionDir(date)).toBe(join(root, "250714_1530"));
    expect(noProjectSessionDir(date)).toBe(join(root, "250714_153012"));
    expect(noProjectSessionDir(date)).toBe(join(root, "250714_153012_1"));
    expect(existsSync(join(root, "250714_1530"))).toBe(true);
  });

  it("uses Documents when that folder exists", () => {
    expect(
      resolveNoProjectRoot({
        home: "/home/me",
        env: {},
        platform: "linux",
        exists: (path) => path === "/home/me/Documents",
      }),
    ).toBe("/home/me/Documents/LeafCodePi");
  });

  it("falls back to XDG data home when Documents is missing", () => {
    expect(
      resolveNoProjectRoot({
        home: "/home/me",
        env: { XDG_DATA_HOME: "/xdg/data" },
        platform: "linux",
        exists: () => false,
      }),
    ).toBe("/xdg/data/LeafCodePi");
  });

  it("uses ~/.local/share/LeafCodePi when Documents and XDG_DATA_HOME are absent", () => {
    expect(
      resolveNoProjectRoot({
        home: "/home/me",
        env: {},
        platform: "linux",
        exists: () => false,
      }),
    ).toBe("/home/me/.local/share/LeafCodePi");
  });

  it("keeps Windows Documents when present and otherwise ~/LeafCodePi", () => {
    expect(
      resolveNoProjectRoot({
        home: "C:\\Users\\sam",
        env: {},
        platform: "win32",
        exists: (path) => path === join("C:\\Users\\sam", "Documents"),
      }),
    ).toBe(join("C:\\Users\\sam", "Documents", "LeafCodePi"));
    expect(
      resolveNoProjectRoot({
        home: "C:\\Users\\sam",
        env: {},
        platform: "win32",
        exists: () => false,
      }),
    ).toBe(join("C:\\Users\\sam", "LeafCodePi"));
  });
});
