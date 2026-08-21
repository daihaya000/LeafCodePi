import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "./config.js";

const DEFAULTS = { autoOpenBrowser: false };

function configFile() {
  return join(dataDir(), "browser-config.json");
}

/** @returns {{ autoOpenBrowser: boolean }} */
export function readBrowserConfig() {
  try {
    if (!existsSync(configFile())) return { ...DEFAULTS };
    const parsed = JSON.parse(readFileSync(configFile(), "utf8"));
    return { autoOpenBrowser: parsed?.autoOpenBrowser === true };
  } catch {
    return { ...DEFAULTS };
  }
}

/** @param {{ autoOpenBrowser?: boolean }} patch */
export function writeBrowserConfig(patch) {
  const next = {
    autoOpenBrowser:
      typeof patch?.autoOpenBrowser === "boolean"
        ? patch.autoOpenBrowser
        : readBrowserConfig().autoOpenBrowser,
  };
  const file = configFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
  return next;
}
