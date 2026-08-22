import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { browseAllowedRoots, isAllowedBrowsePath } from "./browse-paths";

const originalAppData = process.env.APPDATA;
let appData: string;

beforeEach(() => {
  appData = mkdtempSync(join(tmpdir(), "leafcode-pi-browse-"));
  process.env.APPDATA = appData;
  mkdirSync(join(appData, "leafcode-pi"), { recursive: true });
  writeFileSync(
    join(appData, "leafcode-pi", "store.json"),
    JSON.stringify({ version: 1, projects: [], tasks: [] }, null, 2),
  );
});

afterEach(() => {
  if (originalAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = originalAppData;
  rmSync(appData, { recursive: true, force: true });
});

describe("isAllowedBrowsePath", () => {
  it("allows homedir and subpaths", () => {
    const home = homedir();
    expect(isAllowedBrowsePath(home)).toBe(true);
    expect(isAllowedBrowsePath(join(home, "Documents"))).toBe(true);
  });

  it("blocks paths outside allowed roots", () => {
    expect(isAllowedBrowsePath("C:\\Windows")).toBe(false);
  });

  it("includes registered project roots", () => {
    const projectRoot = resolve(join(appData, "my-project"));
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
