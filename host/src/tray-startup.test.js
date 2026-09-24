import assert from "node:assert/strict";
import test from "node:test";
import { withSafeInitialMenu } from "./tray-startup.js";

test("Windows systray2 initial menu waits after the helper's ready signal", async () => {
  const writes = [];
  class FakeSysTray {
    writeLine(line) { writes.push(line); }
    async ready() { this.writeLine("initial menu"); }
  }
  const SafeSysTray = withSafeInitialMenu(FakeSysTray, "win32");
  const tray = new SafeSysTray();
  const ready = tray.ready();
  assert.deepEqual(writes, []);
  await ready;
  assert.deepEqual(writes, ["initial menu"]);
  tray.writeLine("update");
  assert.deepEqual(writes, ["initial menu", "update"]);
  assert.equal(withSafeInitialMenu(FakeSysTray, "linux"), FakeSysTray);
});
