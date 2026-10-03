import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { explorerAllowedRoots, explorerOpenCommand, isAllowedExplorerPath, openProjectInExplorer } from "./open-explorer.js";

test("explorerOpenCommand keeps Windows Explorer and uses open/xdg-open elsewhere", () => {
  assert.deepEqual(explorerOpenCommand("win32", "C:\\work\\project"), {
    command: "explorer.exe",
    args: ["C:\\work\\project"],
  });
  assert.deepEqual(explorerOpenCommand("darwin", "/Users/me/project"), {
    command: "open",
    args: ["/Users/me/project"],
  });
  assert.deepEqual(explorerOpenCommand("linux", "/home/me/project"), {
    command: "xdg-open",
    args: ["/home/me/project"],
  });
});

test("openProjectInExplorer resolves when the platform command succeeds", async () => {
  const spawned = [];
  const child = new EventEmitter();
  child.unref = () => {};
  const result = openProjectInExplorer("/home/me/project", {
    platform: "linux",
    allowedRoots: ["/home/me"],
    realpath: (path) => path,
    stat: () => ({ isDirectory: () => true }),
    spawn: (command, args, options) => {
      spawned.push({ command, args, options });
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  });
  await assert.doesNotReject(result);
  assert.deepEqual(await result, { ok: true });
  assert.deepEqual(spawned, [
    { command: "xdg-open", args: ["/home/me/project"], options: { detached: true, stdio: "ignore" } },
  ]);
});

test("explorerAllowedRoots includes the home, no-project root, and registered projects", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "explorer-roots-"));
  try {
    const projectRoot = join(tempDir, "registered-project");
    const storeFile = join(tempDir, "store.json");
    writeFileSync(storeFile, JSON.stringify({ version: 1, projects: [{ rootPath: projectRoot }] }));
    const roots = explorerAllowedRoots({
      home: tempDir,
      env: {},
      noProjectRoot: join(tempDir, "no-project"),
      storeFile,
    });
    assert.deepEqual(new Set(roots), new Set([resolve(tempDir), resolve(projectRoot), resolve(tempDir, "no-project")]));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("isAllowedExplorerPath blocks outside roots and symlink escapes", () => {
  const options = { platform: "linux", allowedRoots: ["/home/me"], realpath: (path) => path };
  assert.equal(isAllowedExplorerPath("/home/me/project/src", options), true);
  assert.equal(isAllowedExplorerPath("/etc", options), false);
  assert.equal(
    isAllowedExplorerPath("/home/me/link", {
      ...options,
      realpath: (path) => path === "/home/me/link" ? "/etc" : path,
    }),
    false,
  );
});

test("openProjectInExplorer rejects paths outside allowed roots before filesystem access", () => {
  let spawned = false;
  let statCalls = 0;
  assert.throws(
    () => openProjectInExplorer("/outside/project", {
      platform: "linux",
      allowedRoots: ["/home/me"],
      realpath: (path) => path,
      stat: () => { statCalls += 1; return { isDirectory: () => true }; },
      spawn: () => { spawned = true; },
    }),
    (error) => error.status === 403,
  );
  assert.equal(statCalls, 0);
  assert.equal(spawned, false);
});

test("openProjectInExplorer rejects non-directories and relative paths before spawning", async () => {
  let spawned = false;
  const options = {
    platform: "linux",
    allowedRoots: ["/home/me"],
    realpath: (path) => path,
    stat: () => ({ isDirectory: () => false }),
    spawn: () => { spawned = true; },
  };
  assert.throws(() => openProjectInExplorer("/home/me/file.txt", options), (error) => error.status === 400);
  assert.throws(() => openProjectInExplorer("relative/project", options), (error) => error.status === 400);
  assert.equal(spawned, false);
});

test("openProjectInExplorer reports an xdg-open failure", async () => {
  const child = new EventEmitter();
  child.unref = () => {};
  const result = openProjectInExplorer("/home/me/project", {
    platform: "linux",
    allowedRoots: ["/home/me"],
    realpath: (path) => path,
    stat: () => ({ isDirectory: () => true }),
    spawn: () => {
      queueMicrotask(() => {
        child.emit("spawn");
        child.emit("exit", 3, null);
      });
      return child;
    },
  });
  await assert.rejects(result, /xdg-open exited with code 3/);
});
