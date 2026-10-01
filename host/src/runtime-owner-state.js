import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The durable answer to "who owns the Pi runtime?".
 *
 * The cutover hands the runtime to the Backend, and that decision has to outlive the Host process:
 * a Host restarted without it would bring the WebUI back as an owner next to the Backend's child
 * lifecycle. The cutover writes this file, the Host reads it on startup, and a missing, unreadable
 * or unknown value means the WebUI owns the runtime (the pre-cutover default, which never starts a
 * second owner because the Backend is stopped with the Host).
 */
export const RUNTIME_OWNER_FILE = "runtime-owner.json";
/** The Backend owns the Pi runtime; the WebUI is its client. */
export const BACKEND_OWNER = "backend";
/** The WebUI owns the Pi runtime; the Backend stays detached. */
export const IN_PROCESS_OWNER = "in-process";

export function runtimeOwnerPath(dataDir) {
  return join(dataDir, RUNTIME_OWNER_FILE);
}

/** Missing, unreadable or unknown means the WebUI owns the runtime. Never throws. */
export function readRuntimeOwner(dataDir, { readFile = readFileSync } = {}) {
  try {
    const parsed = JSON.parse(readFile(runtimeOwnerPath(dataDir), "utf8"));
    return parsed?.owner === BACKEND_OWNER ? BACKEND_OWNER : IN_PROCESS_OWNER;
  } catch {
    return IN_PROCESS_OWNER;
  }
}

/**
 * Records the ownership for the next Host start. A write failure is reported, never thrown: the
 * running system stays consistent, only the next start would fall back to the WebUI owning it.
 */
export function writeRuntimeOwner(
  dataDir,
  owner,
  { writeFile = writeFileSync, mkdir = mkdirSync, now = () => new Date().toISOString() } = {},
) {
  const value = owner === BACKEND_OWNER ? BACKEND_OWNER : IN_PROCESS_OWNER;
  try {
    mkdir(dataDir, { recursive: true });
    writeFile(runtimeOwnerPath(dataDir), `${JSON.stringify({ owner: value, updatedAt: now() })}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}
