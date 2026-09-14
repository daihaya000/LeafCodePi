import { afterEach, beforeEach, vi } from "vitest";

// Keep LEAFCODE_PI_DATA_DIR from vitest.config.ts. Linux dataDir() ignores
// APPDATA, so deleting the override sent tests at ~/.leafcode-pi and
// assertTestSafe threw. Windows still uses APPDATA when the override is empty.
const initialEnv = { ...process.env };

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in initialEnv)) delete process.env[key];
  }
  Object.assign(process.env, initialEnv);
}

beforeEach(restoreEnv);
afterEach(() => {
  vi.unstubAllEnvs();
  restoreEnv();
});
