import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildHostRestartScript } from "./host-restart.js";
import { dataDir, DEFAULT_WEBUI_PORT } from "./config.js";
import { localLeafcodePiTempDir, withLocalLeafcodeTempEnv } from "./tray-temp.js";

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

test("POSIX tray helpers also isolate TMPDIR and restore it", async () => {
  const env = { TMPDIR: "/tmp/original", TEMP: "/tmp/temp", TMP: "/tmp/tmp" };
  let during;
  await withLocalLeafcodeTempEnv(
    async (dir) => {
      during = { dir, tmpdir: env.TMPDIR, temp: env.TEMP, tmp: env.TMP };
    },
    { env, dir: "/tmp/leafcode-pi/tmp", platform: "linux", mkdirSync: () => {} },
  );
  assert.deepEqual(during, {
    dir: "/tmp/leafcode-pi/tmp",
    tmpdir: "/tmp/leafcode-pi/tmp",
    temp: "/tmp/leafcode-pi/tmp",
    tmp: "/tmp/leafcode-pi/tmp",
  });
  assert.deepEqual(env, { TMPDIR: "/tmp/original", TEMP: "/tmp/temp", TMP: "/tmp/tmp" });
});

test("Linux desktop launcher resolves its checkout from %k", () => {
  const desktop = readFileSync(join(repoRoot, "LeafCodePi.desktop"), "utf8");
  assert.match(desktop, /Exec=\/bin\/sh -c .* sh %k$/m);
  assert.ok(desktop.includes('dirname -- \\\"$1\\\"'));
  assert.doesNotMatch(desktop, /\/home\/daichi\//);
});

test("launcher bats use LEAFCODE_PI_* and port 3010", () => {
  const bat = readFileSync(join(repoRoot, "scripts", "start-webui.bat"), "utf8");
  assert.match(bat, /LEAFCODE_PI_PORT=3010/);
  assert.match(bat, /LEAFCODE_PI_HOST=tailscale/);
  assert.match(bat, /title LeafCodePi/);
  assert.match(bat, /call :install_gh\r?\ncall :install_web/);
  assert.match(bat, /winget install --id GitHub\.cli --exact/);
  assert.match(bat, /:gh_warning\r?\necho .*GitHub CLI is unavailable.*\r?\nexit \/b 0/);
  assert.doesNotMatch(bat, /LEAFCODE_PORT=/);
  assert.doesNotMatch(bat, /LEAFCODE_DATA_DIR=/);
  assert.doesNotMatch(bat, /LEAFCODE_HEADLESS=/);
});

test("launcher restarts the host after an unclean exit, not after a clean quit", () => {
  const bat = readFileSync(join(repoRoot, "scripts", "start-webui.bat"), "utf8");
  assert.match(bat, /^:run_host$/m);
  assert.match(bat, /if "%ERR%"=="0" goto :host_done/);
  assert.match(bat, /if %RESTARTS% GEQ %LEAFCODE_PI_RESTART_MAX% goto :host_failed/);
  // Same rule as the WebUI crash budget: a host that stayed up gets its budget back.
  assert.match(bat, /Date\.now\(\)-%STARTED_AT%>=60000/);
  assert.match(bat, /if "%SHORT_RUN%"=="0" set \/a RESTARTS=0/);
  assert.match(bat, /^goto :run_host$/m);
});

test("both launchers enforce the engines Node.js minimum", () => {
  // package.json engines says >=22.19. The bat once accepted any major >=20,
  // which let unsupported runtimes fail later inside the build instead.
  const bat = readFileSync(join(repoRoot, "scripts", "start-webui.bat"), "utf8");
  assert.match(bat, /major < 22/);
  assert.match(bat, /major === 22 && minor < 19/);
  assert.doesNotMatch(bat, /NODE_MAJOR/);
  // An already-installed older LTS makes `winget install` exit 0 without
  // upgrading, so the launcher must fall back to an explicit upgrade.
  assert.match(bat, /winget upgrade --id OpenJS\.NodeJS\.LTS --exact/);
  const sh = readFileSync(join(repoRoot, "start.sh"), "utf8");
  assert.match(sh, /major < 22 \|\| \(major === 22 && minor < 19\)/);
});

test("desktop shortcut name is LeafCodePi.lnk", () => {
  const ps1 = readFileSync(join(repoRoot, "scripts", "create-shortcut.ps1"), "utf8");
  assert.match(ps1, /LeafCodePi\.lnk/);
  assert.doesNotMatch(ps1, /LeafCode\.lnk/);
  assert.match(ps1, /leafcode-pi/);
});

test("host restart relaunches through LeafCodePi.exe when available", () => {
  const lines = buildHostRestartScript({
    lockFile: "C:\\Users\\Daichi\\AppData\\Roaming\\leafcode-pi\\host.lock",
    launcherExe: "C:\\Users\\Daichi\\LeafCodePi\\LeafCodePi.exe",
    startBat: "C:\\Users\\Daichi\\LeafCodePi\\scripts\\start-webui.bat",
  });
  const script = lines.join("\n");
  assert.ok(
    script.includes(String.raw`start "LeafCodePi" /min "C:\Users\Daichi\LeafCodePi\LeafCodePi.exe"`),
  );
  assert.doesNotMatch(script, /cmd\.exe/);
  assert.match(script, /LEAFCODE_PI_SKIP_STALE_REBUILD=1/);
  // A stale lock (old host killed before removing it) must not wait forever.
  assert.match(script, /set \/a WAIT\+=1/);
  assert.match(script, /if %WAIT% GEQ 120 goto :launch/);
});

test("host restart launcher gives up waiting for a stale lock", { skip: process.platform !== "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "leafcode-restart-"));
  try {
    const lock = join(dir, "host.lock");
    writeFileSync(lock, '{"pid":1}\n', "utf8"); // never removed
    const lines = buildHostRestartScript({
      lockFile: lock,
      launcherExe: join(dir, "fake-launcher.exe"),
      startBat: join(dir, "start-webui.bat"),
      maxWaitAttempts: 1,
    });
    // Replace the windowed launch with a marker: the bound of the wait loop is
    // what this test exercises, not spawning another process.
    const scriptPath = join(dir, "restart.bat");
    const script = lines
      .map((line) => (line.startsWith("start ") ? "echo LAUNCHED" : line))
      .join("\r\n");
    writeFileSync(scriptPath, `${script}\r\n`, "ascii");
    const result = spawnSync("cmd.exe", ["/c", scriptPath], {
      timeout: 10_000,
      encoding: "utf8",
      windowsHide: true,
    });
    // The launcher deletes itself, so its own exit code is not the contract;
    // reaching the launch line before the timeout is.
    assert.equal(result.error, undefined);
    assert.match(result.stdout, /LAUNCHED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("host restart falls back to start-webui.bat without the native launcher", () => {
  const lines = buildHostRestartScript({
    lockFile: "C:\\Users\\Daichi\\AppData\\Roaming\\leafcode-pi\\host.lock",
    launcherExe: null,
    startBat: "C:\\Users\\Daichi\\LeafCodePi\\scripts\\start-webui.bat",
  });
  assert.match(lines.join("\n"), /cmd\.exe \/c/);
});

test("WebUI restart pulls, rebuilds only after an update or on request, then starts without pulling twice", () => {
  const index = readFileSync(join(repoRoot, "host", "src", "index.js"), "utf8");
  const restart = index.slice(index.indexOf("async function restartWeb("), index.indexOf("async function restartHost("));
  assert.match(restart, /const \{ updated \} = pullLatestSources\(/);
  assert.match(restart, /await stopWeb\(\);\s*if \(rebuild \|\| updated\)/);
  assert.match(restart, /await buildWeb\([^;]+\{ pull: false \}\)/);
  assert.match(restart, /await spawnWeb\(\{ pull: false \}\)/);
});

test("host rebuilds stale production builds like LeafCode", () => {
  const index = readFileSync(join(repoRoot, "host", "src", "index.js"), "utf8");
  assert.match(index, /isWebBuildStale/);
  assert.match(index, /staleRebuildFailureAction/);
  assert.match(index, /continuing with the existing production build/);
  // The production build moved into the hard-link mirror outside OneDrive, so
  // the batch can no longer look for BUILD_ID itself; the host reports instead.
  const bat = readFileSync(join(repoRoot, "scripts", "start-webui.bat"), "utf8");
  assert.match(bat, /Host will build the WebUI on start if it is missing or stale/);
  assert.doesNotMatch(bat, /\.next\\BUILD_ID/);
});
