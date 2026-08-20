/**
 * Standalone llama-server tray icon.
 *
 * Runs as an independent Node process (spawned via WMI by
 * llama-server-service.js, outside LeafCodePi's Kill-On-Job-Close job) so it
 * stays resident next to llama-server and survives LeafCodePi quitting, just
 * like the server itself. Provides a tray entry point to open the llama.cpp
 * WebUI and to stop llama-server + the tray together.
 *
 * Lifecycle contract with llama-server-service.js:
 *   - it is launched when llama-server starts, and both are stopped together.
 *   - The tray polls /health and live-updates its status line.
 *   - "Stop" kills llama-server (the PID listening on the port) then removes
 *     this tray; "Quit" removes only this tray.
 *
 * It communicates with the parent (the llama-server-service) only through
 * signals we do not need: it is fully self-contained on argv (port).
 */

import SysTrayImport from 'systray2';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { hardKillTree } from './process-stop.js';
import { getListeningPids } from './port-scanner.js';
import { withLocalLeafcodeTempEnv } from './tray-temp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SysTray =
  SysTrayImport?.default?.default ||
  SysTrayImport?.default ||
  SysTrayImport;
if (typeof SysTray !== 'function') {
  throw new Error(
    `systray2 import failed (got ${typeof SysTrayImport}). Reinstall host deps: cd host && npm install`,
  );
}

const PORT = Number(process.argv[2] ?? 8081);
const UI_URL = `http://127.0.0.1:${PORT}/`;

// Brand icon (same as LeafCodePi host tray).
const iconData = JSON.parse(readFileSync(join(__dirname, 'icon.json'), 'utf8'));
const ICON = iconData.base64;

/** Kill every live PID listening on :PORT (the llama-server process). */
async function stopLlamaServer() {
  const pids = getListeningPids(PORT);
  for (const pid of pids) {
    const n = Number(pid);
    if (Number.isFinite(n) && n > 0) {
      hardKillTree(n);
    }
  }
}

function openBrowser(url) {
  spawn('cmd', ['/c', 'start', '', url], {
    detached: true,
    stdio: 'ignore',
    shell: false,
  }).unref();
}

let systray = null;
let lastHealthValue = null;

/** Fixed status item object: systray2's update-item needs the __id that was
 *  assigned to THIS object at menu build time. Re-creating the object on every
 *  poll would send an update without __id and corrupt the tray menu. */
const statusItem = {
  title: 'llama-server: …',
  tooltip: 'Checking…',
  checked: false,
  enabled: false,
};

/** @returns {Promise<'ok' | 'down'>} */
async function probeHealth() {
  try {
    const res = await fetch(`${UI_URL.replace(/\/$/, '')}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return 'down';
    const body = await res.json().catch(() => null);
    return body && typeof body === 'object' && body.status === 'ok' ? 'ok' : 'down';
  } catch {
    return 'down';
  }
}

function updateStatusItem() {
  const ok = lastHealthValue === 'ok';
  statusItem.title = ok ? 'llama-server: running' : 'llama-server: stopped';
  statusItem.tooltip = ok ? `Healthy at ${UI_URL}` : 'Not responding';
}

function buildMenu() {
  return {
    icon: ICON,
    title: 'llama-server',
    tooltip: `llama-server (${PORT})`,
    items: [
      {
        title: 'Open llama.cpp UI',
        tooltip: `Open ${UI_URL}`,
        checked: false,
        enabled: true,
        click: () => openBrowser(UI_URL),
      },
      SysTray.separator,
      statusItem,
      {
        title: 'Stop llama-server',
        tooltip: 'Stop the llama-server process and remove this tray',
        checked: false,
        enabled: true,
        click: () => {
          stopLlamaServer()
            .catch(() => {})
            .finally(() => {
              void quitTray();
            });
        },
      },
      SysTray.separator,
      {
        title: 'Quit tray',
        tooltip: 'Remove this tray icon only (llama-server keeps running)',
        checked: false,
        enabled: true,
        click: () => {
          quitTray();
        },
      },
    ],
  };
}

async function quitTray() {
  try {
    await systray?.kill(false);
  } catch {
    // best effort
  }
  process.exit(0);
}

async function pollLoop() {
  for (;;) {
    lastHealthValue = await probeHealth();
    updateStatusItem();
    if (systray) {
      try {
        systray.sendAction({ type: 'update-item', item: statusItem });
      } catch {
        // tray may be gone
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

async function main() {
  return withLocalLeafcodeTempEnv(async () => {
    let lastErr;
    for (const copyDir of [true, false]) {
      try {
        systray = new SysTray({
          menu: buildMenu(),
          debug: false,
          copyDir,
        });
        systray.onClick((action) => {
          if (action.item?.click) {
            action.item.click();
          }
        });
        await systray.ready();
        // eslint-disable-next-line no-console
        console.log(`llama-server tray ready (port ${PORT}, copyDir=${copyDir})`);
        void pollLoop(); // periodic /health polling
        return;
      } catch (err) {
        lastErr = err;
        try {
          await systray?.kill(false);
        } catch {
          // best effort
        }
        systray = null;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(`llama-server tray failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
