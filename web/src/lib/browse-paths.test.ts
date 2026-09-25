import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browseAllowedRoots, isAllowedBrowsePath } from "./browse-paths";

const originalAppData = process.env.APPDATA;
const originalDataDir = process.env.LEAFCODE_PI_DATA_DIR;
const originalOneDrive = process.env.OneDrive;
let appData: string;

beforeEach(() => {
  appData = mkdtempSync(join(tmpdir(), "leafcode-pi-browse-"));
  process.env.APPDATA = appData;
  // Windows dataDir() uses APPDATA; Linux needs the explicit override.
  process.env.LEAFCODE_PI_DATA_DIR = join(appData, "leafcode-pi");
  mkdirSync(join(appData, "leafcode-pi"), { recursive: true });
  writeFileSync(
    join(appData, "leafcode-pi", "store.json"),
    JSON.stringify({ version: 1, projects: [], tasks: [] }, null, 2),
  );
});

afterEach(() => {
  if (originalAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = originalAppData;
  if (originalDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
  else process.env.LEAFCODE_PI_DATA_DIR = originalDataDir;
  if (originalOneDrive === undefined) delete process.env.OneDrive;
  else process.env.OneDrive = originalOneDrive;
  rmSync(appData, { recursive: true, force: true });
});

describe("isAllowedBrowsePath", () => {
  it("allows homedir", () => {
    expect(isAllowedBrowsePath(homedir())).toBe(true);
  });

  it("preserves POSIX path case", () => {
    const identity = (path: string) => path;
    expect(
      isAllowedBrowsePath("/mnt/data/project", {
        platform: "linux",
        roots: ["/mnt/Data"],
        realpath: identity,
      }),
    ).toBe(false);
  });

  it("blocks a symlink that resolves outside an allowed root", () => {
    expect(
      isAllowedBrowsePath("/home/user/link", {
        platform: "linux",
        roots: ["/home/user"],
        realpath: (path) => (path === "/home/user/link" ? "/etc" : path),
      }),
    ).toBe(false);
  });

  it("rejects a UNC path outside the roots without touching the file system", () => {
    const realpath = vi.fn((path: string) => path);
    expect(
      isAllowedBrowsePath("\\\\attacker\\share\\x", { platform: "win32", roots: ["C:\\Users\\me"], realpath }),
    ).toBe(false);
    expect(realpath).not.toHaveBeenCalledWith(expect.stringMatching(/^\\\\attacker/));
  });

  it("allows a UNC path under a registered UNC root", () => {
    expect(
      isAllowedBrowsePath("\\\\nas\\work\\repo\\src", {
        platform: "win32",
        roots: ["\\\\nas\\work\\repo"],
        realpath: (path) => path,
      }),
    ).toBe(true);
  });

  it("allows the real path of a junctioned root", () => {
    expect(
      isAllowedBrowsePath("D:\\Users\\me\\x", {
        platform: "win32",
        roots: ["C:\\Users\\me"],
        realpath: (path) => path.replace(/^C:\\Users\\me/i, "D:\\Users\\me"),
      }),
    ).toBe(true);
  });

  it("blocks paths outside allowed roots", () => {
    expect(isAllowedBrowsePath("C:\\Windows")).toBe(false);
  });

  it("includes a configured OneDrive root", () => {
    const oneDrive = join(appData, "OneDrive");
    const projects = join(oneDrive, "Projects");
    mkdirSync(projects, { recursive: true });
    process.env.OneDrive = oneDrive;

    expect(browseAllowedRoots()).toContain(resolve(oneDrive));
    expect(isAllowedBrowsePath(projects)).toBe(true);
  });

  it("includes registered project roots", () => {
    const projectRoot = resolve(join(appData, "my-project"));
    mkdirSync(join(projectRoot, "src"), { recursive: true });
    writeFileSync(
      join(appData, "leafcode-pi", "store.json"),
      JSON.stringify(
        {
          version: 1,
          projects: [
            {
              id: "p1",
              name: "Demo",
              rootPath: projectRoot,
              favorite: false,
              archived: false,
              createdAt: new Date().toISOString(),
              lastOpenedAt: new Date().toISOString(),
            },
          ],
          tasks: [],
        },
        null,
        2,
      ),
    );
    expect(browseAllowedRoots()).toContain(projectRoot);
    expect(isAllowedBrowsePath(join(projectRoot, "src"))).toBe(true);
  });
});
