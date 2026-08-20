import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dataDir, DEFAULT_WEBUI_PORT } from "./config.js";
import { localLeafcodePiTempDir } from "./tray-temp.js";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

test("default WebUI port does not collide with LeafCode's 3000", () => {
  assert.equal(DEFAULT_WEBUI_PORT, 3010);
  assert.notEqual(DEFAULT_WEBUI_PORT, 3000);
});

test("data dir is leafcode-pi, not LeafCode's leafcode", () => {
  const dir = dataDir({ APPDATA: "C:\\Roaming" });
  assert.ok(dir.replace(/\//g, "\\").endsWith("leafcode-pi"));
  assert.ok(!dir.replace(/\\/g, "/").endsWith("/leafcode"));
});

test("tray TEMP is leafcode-pi\\tmp, not leafcode\\tmp", () => {
  const dir = localLeafcodePiTempDir({ LOCALAPPDATA: "C:\\Local" });
  assert.match(dir.replace(/\//g, "\\"), /leafcode-pi\\tmp$/);
  assert.ok(!dir.includes("\\leafcode\\tmp"));
});

test("launcher bats use LEAFCODE_PI_* and port 3010", () => {
  const bat = readFileSync(join(repoRoot, "scripts", "start-webui.bat"), "utf8");
  assert.match(bat, /LEAFCODE_PI_PORT=3010/);
  assert.match(bat, /title LeafCodePi/);
  assert.doesNotMatch(bat, /LEAFCODE_PORT=/);
  assert.doesNotMatch(bat, /LEAFCODE_DATA_DIR=/);
  assert.doesNotMatch(bat, /LEAFCODE_HEADLESS=/);
});

test("desktop shortcut name is LeafCodePi.lnk", () => {
  const ps1 = readFileSync(join(repoRoot, "scripts", "create-shortcut.ps1"), "utf8");
  assert.match(ps1, /LeafCodePi\.lnk/);
  assert.doesNotMatch(ps1, /LeafCode\.lnk/);
  assert.match(ps1, /leafcode-pi/);
});

test("host rebuilds stale production builds like LeafCode", () => {
  const index = readFileSync(join(repoRoot, "host", "src", "index.js"), "utf8");
  assert.match(index, /isWebBuildStale/);
  assert.match(index, /rebuildReason === "stale"/);
  assert.match(index, /continuing with the existing production build/);
  const bat = readFileSync(join(repoRoot, "scripts", "start-webui.bat"), "utf8");
  assert.match(bat, /host will rebuild if sources are newer/);
});
