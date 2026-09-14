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

test("openProjectInExplorer spawns the platform command and resolves on spawn", async () => {
  const spawned = [];
  const child = new EventEmitter();
  child.unref = () => {};
  const result = openProjectInExplorer("/home/me/project", {
    platform: "linux",
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
