import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { seedMissingBrowserSettings } from "./spa-browser-storage.mjs";

// Playwright serializes init functions; exercise that standalone browser body,
// without exposing/mutating the test process's globals or importing app code.
function harness({ protocol = "http:", child = false, existing = {} } = {}) {
  const values = new Map(Object.entries(existing)), writes = [];
  const window = {}; window.top = child ? {} : window;
  const scope = { window, location: { protocol }, localStorage: {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); writes.push([key, value]); },
  } };
  return { values, writes, seed: seed => runInNewContext(`(${seedMissingBrowserSettings.toString()})(seed)`, { ...scope, seed }) };
}

test("initial browser navigation seeds only absent settings", () => {
  const browser = harness(); browser.seed({ panes: "initial", theme: "dark" });
  assert.deepEqual([...browser.values], [["panes", "initial"], ["theme", "dark"]]);
});
test("reload preserves a layout saved after the initial navigation", () => {
  const browser = harness(); browser.seed({ panes: "initial" });
  browser.values.set("panes", "reordered-and-split"); browser.seed({ panes: "initial" });
  assert.equal(browser.values.get("panes"), "reordered-and-split");
  assert.deepEqual(browser.writes, [["panes", "initial"]]);
});
test("existing empty/false/zero settings are not mistaken for missing", () => {
  const browser = harness({ existing: { empty: "", off: "false", volume: "0" } });
  browser.seed({ empty: "replacement", off: "true", volume: "100", missing: "new" });
  assert.deepEqual(browser.writes, [["missing", "new"]]);
  assert.deepEqual([...browser.values], [["empty", ""], ["off", "false"], ["volume", "0"], ["missing", "new"]]);
});
test("opaque about:blank and file pages never access browser storage", () => {
  for (const protocol of ["about:", "file:"]) {
    const browser = harness({ protocol }); browser.seed({ panes: "initial" });
    assert.deepEqual(browser.writes, []);
  }
});
test("child frames never seed the top-level settings", () => {
  const browser = harness({ child: true, protocol: "https:" }); browser.seed({ panes: "initial" });
  assert.deepEqual(browser.writes, []);
});
