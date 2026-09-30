import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  dataDir, displayLeafcodePiDataPath, isAbsolutePath, noProjectSessionDir, pathKey, resolveNoProjectRoot,
  sameOrDescendantPath, samePath, storePath, webUiAuthConfigPath,
} from "./app-paths.mjs";
import { parseXdgUserDirsFile, readXdgUserDirs } from "./xdg-user-dirs.mjs";

function withEnv(values, action) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  try { return action(); }
  finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

test("the data directory honours the override first, is read at call time, and derives file paths", () => {
  const root = mkdtempSync(join(tmpdir(), "leafcode-app-paths-"));
  try {
    withEnv({ NODE_ENV: undefined, LEAFCODE_PI_DATA_DIR: `  ${root}  ` }, () => {
      assert.equal(dataDir(), root);
      assert.equal(storePath(), join(root, "store.json"));
      assert.equal(webUiAuthConfigPath(), join(root, "webui-auth.json"));
    });
    const other = join(root, "other");
    withEnv({ NODE_ENV: undefined, LEAFCODE_PI_DATA_DIR: other }, () => assert.equal(dataDir(), other));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("without an override the default location depends on the platform environment", () => {
  withEnv({ NODE_ENV: undefined, LEAFCODE_PI_DATA_DIR: undefined, APPDATA: "C:\\Users\\x\\AppData\\Roaming" }, () => {
    const value = dataDir();
    if (process.platform === "win32") assert.equal(value, join("C:\\Users\\x\\AppData\\Roaming", "leafcode-pi"));
    else assert.ok(value.endsWith(".leafcode-pi"));
  });
});

test("the test-environment guard refuses the live data directory but allows the temp directory", () => {
  withEnv({ NODE_ENV: "test", LEAFCODE_PI_DATA_DIR: join(tmpdir(), "leafcode-guard-ok") }, () => {
    assert.equal(dataDir(), join(tmpdir(), "leafcode-guard-ok"));
  });
  withEnv({ NODE_ENV: "test", LEAFCODE_PI_DATA_DIR: undefined }, () => {
    assert.throws(() => dataDir(), /Refusing to use the live LeafCodePi directory/);
  });
  withEnv({ NODE_ENV: "test", LEAFCODE_PI_DATA_DIR: join(process.cwd(), "outside-temp-root") }, () => {
    assert.throws(() => storePath(), /Refusing to use the live LeafCodePi directory/);
  });
});

test("path comparison follows the platform: case-insensitive on win32, exact on posix", () => {
  assert.equal(samePath("C:\\Work\\Demo", "c:/work/demo", "win32"), true);
  assert.equal(samePath("/work/Demo", "/work/demo", "linux"), false);
  assert.equal(pathKey("C:\\A\\..\\B", "win32"), "c:\\b");
  assert.equal(sameOrDescendantPath("C:\\Work\\Demo\\sub", "c:\\work", "win32"), true);
  assert.equal(sameOrDescendantPath("C:\\Workshop", "C:\\Work", "win32"), false);
  assert.equal(sameOrDescendantPath("/a/b", "/a/b", "linux"), true);
  assert.equal(sameOrDescendantPath("/a/bc", "/a/b", "linux"), false);
});

test("user-facing data paths use the env or tilde form and normalise separators", () => {
  assert.equal(displayLeafcodePiDataPath("logs/a.log", "win32", "D:\\data\\"), "D:\\data\\logs\\a.log");
  assert.equal(displayLeafcodePiDataPath("/logs\\a.log", "linux", "/data/"), "/data/logs/a.log");
  assert.equal(displayLeafcodePiDataPath("", "win32", ""), "%APPDATA%\\leafcode-pi");
  assert.equal(displayLeafcodePiDataPath("x", "linux", undefined), "~/.leafcode-pi/x");
});

test("absolute path detection accepts drive, POSIX and UNC forms only", () => {
  for (const value of ["C:\\x", "c:/x", "/x", "\\\\host\\share"]) assert.equal(isAbsolutePath(value), true, value);
  for (const value of ["", "   ", "relative/x", "C:x", "./x"]) assert.equal(isAbsolutePath(value), false, value);
});

test("the no-project workspace root prefers the override, then Documents, then platform fallbacks", () => {
  const existing = new Set(["/home/u/Documents"]);
  const exists = (path) => existing.has(path);
  assert.equal(resolveNoProjectRoot({ env: { LEAFCODE_PI_DEFAULT_DIR: "/custom" }, home: "/home/u", platform: "linux", exists }), resolve("/custom"));
  assert.equal(resolveNoProjectRoot({ env: {}, home: "/home/u", platform: "linux", exists }), "/home/u/Documents/LeafCodePi");
  assert.equal(resolveNoProjectRoot({ env: {}, home: "/home/u", platform: "linux", exists: () => false }), "/home/u/.local/share/LeafCodePi");
  assert.equal(resolveNoProjectRoot({ env: { XDG_DATA_HOME: "/xdg/data" }, home: "/home/u", platform: "linux", exists: () => false }), "/xdg/data/LeafCodePi");
  assert.equal(resolveNoProjectRoot({ env: {}, home: "C:\\Users\\u", platform: "win32", exists: () => false }), "C:\\Users\\u\\LeafCodePi");
  assert.equal(resolveNoProjectRoot({ env: {}, home: "C:\\Users\\u", platform: "win32", exists: (path) => path === "C:\\Users\\u\\Documents" }), "C:\\Users\\u\\Documents\\LeafCodePi");
});

test("XDG user dirs: the desktop file wins over env and expands $HOME, ~ and octal escapes", () => {
  const parsed = parseXdgUserDirsFile('# c\nXDG_DOCUMENTS_DIR="$HOME/Docs\\040X"\nXDG_PICTURES_DIR=~/Pics\nXDG_OTHER_DIR="/x"\n', "/home/u");
  assert.deepEqual(parsed, { documents: "/home/u/Docs X", pictures: "/home/u/Pics" });
  const merged = readXdgUserDirs({
    home: "/home/u", env: { XDG_DOCUMENTS_DIR: "/env/docs", XDG_DESKTOP_DIR: "$HOME/Desk" }, configPath: "/cfg",
    readFile: () => 'XDG_DOCUMENTS_DIR="/file/docs"',
  });
  assert.deepEqual(merged, { documents: "/file/docs", desktop: "/home/u/Desk" });
  assert.deepEqual(readXdgUserDirs({ home: "/h", env: {}, readFile: () => { throw new Error("unreadable"); } }), {});
});

test("workspaces are created inside the configured root and never collide", () => {
  const root = mkdtempSync(join(tmpdir(), "leafcode-workspaces-"));
  try {
    withEnv({ NODE_ENV: undefined, LEAFCODE_PI_DEFAULT_DIR: root }, () => {
      const when = new Date(2026, 8, 30, 12, 34, 56);
      const first = noProjectSessionDir(when);
      const second = noProjectSessionDir(when);
      const third = noProjectSessionDir(when);
      assert.equal(first, join(root, "260930_1234"));
      assert.equal(second, join(root, "260930_123456"));
      assert.equal(third, join(root, "260930_123456_1"));
      for (const directory of [first, second, third]) assert.equal(existsSync(directory), true);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("plain Node resolves paths without importing the Web app", () => {
  const moduleUrl = new URL("./app-paths.mjs", import.meta.url).href;
  const code = `
    import { dataDir, storePath } from ${JSON.stringify(moduleUrl)};
    console.log(JSON.stringify({ data: dataDir(), store: storePath() }));
  `;
  const root = mkdtempSync(join(tmpdir(), "leafcode-app-paths-plain-"));
  try {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8", timeout: 5_000, env: { ...process.env, NODE_ENV: "production", LEAFCODE_PI_DATA_DIR: root },
    });
    assert.deepEqual(JSON.parse(output), { data: root, store: join(root, "store.json") });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
