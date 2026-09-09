import { afterEach, beforeEach, vi } from "vitest";

delete process.env.LEAFCODE_PI_DATA_DIR;
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
