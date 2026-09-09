import { configDefaults, defineConfig } from "vitest/config";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Tests change process.env to select their own temp directories. Keep every
// fallback away from the user's live %APPDATA% data even when a test forgets
// to restore one of those variables.
const testDataRoot = join(tmpdir(), `leafcode-pi-vitest-${process.pid}`);

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
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
      LEAFCODE_PI_DEFAULT_DIR: join(testDataRoot, "workspaces"),
    },
    setupFiles: ["./src/test-environment.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "../extensions/**/*.test.ts"],
    exclude: [
      ...configDefaults.exclude,
      "../extensions/**/node_modules/**",
      "../extensions/leafcode-memory/tests/**",
    ],
  },
});
