import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * True when this ESM file is the process entry (Windows `node src\index.js`
 * may pass a relative argv[1]).
 */
export function isThisModuleEntrypoint(metaUrl, argv1) {
  if (!argv1) return false;
  try {
    return resolve(argv1).toLowerCase() === fileURLToPath(metaUrl).toLowerCase();
  } catch {
    return false;
  }
}
