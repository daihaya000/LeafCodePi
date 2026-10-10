import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertInstalledPiVersions, assertPiDependencyVersions } from "../shared/pi-dependencies.mjs";
import { autoUpdatePi } from "../host/src/pi-update.js";

const here = fileURLToPath(import.meta.url);
const root = resolve(dirname(here), "..");

export function main(argv = process.argv.slice(2)) {
  const values = {};
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (key === "--check") values.check = true;
    else if (["--backend", "--startup-host", "--target"].includes(key) && argv[index + 1] && !argv[index + 1].startsWith("--")) {
      values[key] = argv[++index];
    } else throw new Error(`Invalid Pi synchronization argument: ${key}`);
  }
  const backendDir = resolve(values["--backend"] ?? join(root, "backend"));
  if (values.check) {
    const version = assertPiDependencyVersions(backendDir);
    assertInstalledPiVersions(backendDir, version);
    console.log(`Backend Pi dependencies match v${version}`);
    return { safeToStart: true, version };
  }
  const startupHostPid = values["--startup-host"] ? Number(values["--startup-host"]) : null;
  if (startupHostPid !== null && startupHostPid !== process.ppid) throw new Error("Only the starting parent Host may authorize synchronization");
  return autoUpdatePi({
    backendDir, startupHostPid,
    targetVersion: values["--target"] ?? null,
    log: console.log, error: console.error,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === here) {
  try {
    const result = main();
    process.send?.(result);
    if (result.error || !result.safeToStart) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.send?.({ safeToStart: false, error: error.message });
    process.exitCode = 1;
  }
}
