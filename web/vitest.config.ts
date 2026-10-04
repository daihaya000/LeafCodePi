import { configDefaults, defineConfig } from "vitest/config";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Tests change process.env to select their own temp directories. Keep every
// fallback away from the user's live %APPDATA% data even when a test forgets
// to restore one of those variables.
const testDataRoot = join(tmpdir(), `leafcode-pi-vitest-${process.pid}`);

export default defineConfig({
  resolve: {
    // Extension tests live outside web/, but consume the same SDK peer dependencies as the runner.
    dedupe: ["typebox", "@earendil-works/pi-ai", "@earendil-works/pi-tui"],
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@extensions": fileURLToPath(new URL("../extensions", import.meta.url)),
      "@shared": fileURLToPath(new URL(existsSync(fileURLToPath(new URL("./shared", import.meta.url))) ? "./shared" : "../shared", import.meta.url)),
      "@backend-core": fileURLToPath(new URL(existsSync(fileURLToPath(new URL("./backend-core", import.meta.url))) ? "./backend-core" : "../backend/core", import.meta.url)),
    },
  },
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
  test: {
    environment: "node",
    // シェル環境の NODE_ENV=production 継承で production react ビルドが読まれ、
    // React.act が未定義になるためテストでは強制上書きする。
    env: {
      NODE_ENV: "test",
      APPDATA: join(testDataRoot, "appdata"),
      // Linux `dataDir()` ignores APPDATA and uses ~/.leafcode-pi unless this
      // override is set. Keep the fallback inside tmpdir so assertTestSafe
      // accepts it when a test forgets to isolate itself.
      LEAFCODE_PI_DATA_DIR: join(testDataRoot, "data"),
      LEAFCODE_PI_DEFAULT_DIR: join(testDataRoot, "workspaces"),
      // Never deliver real pushes when the developer's shell has Pushover enabled.
      LEAFCODE_PI_PUSHOVER_TOKEN: "",
      LEAFCODE_PI_PUSHOVER_USER: "",
    },
    setupFiles: ["./src/test-environment.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "../extensions/**/*.test.ts"],
    exclude: [
      ...configDefaults.exclude,
      "../extensions/**/node_modules/**",
      "../extensions/leafcode-intercom/**/*.test.ts",
      "../extensions/leafcode-memory/tests/**",
    ],
  },
});
