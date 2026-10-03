import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { explorerOpenCommand, openProjectInExplorer } from "./open-explorer.js";

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

test("openProjectInExplorer rejects non-directories and relative paths before spawning", async () => {
  let spawned = false;
  const options = {
    platform: "linux",
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
