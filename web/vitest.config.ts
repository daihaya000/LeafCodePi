import { configDefaults, defineConfig } from "vitest/config";
import uiModules from "../shared/ui-module-paths.json";
import backendPackage from "../backend/package.json";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Tests change process.env to select their own temp directories. Keep every
// fallback away from the user's live %APPDATA% data even when a test forgets
// to restore one of those variables.
const testDataRoot = join(tmpdir(), `leafcode-pi-vitest-${process.pid}`);
// Legacy owner tests use Backend's installation. These are never Web production dependencies.
const backendImporter = fileURLToPath(new URL("../backend/src/entry.mjs", import.meta.url));
const ownerPackages = new Set([...Object.keys(backendPackage.dependencies), "@earendil-works/pi-agent-core", "@earendil-works/pi-tui"]);
ownerPackages.delete("undici"); // Web transport keeps its own declared undici identity.

export default defineConfig({
  plugins: [{
    name: "backend-runtime-test-identity",
    enforce: "pre",
    async resolveId(id, importer) {
      const packageName = id.startsWith("@") ? id.split("/").slice(0, 2).join("/") : id.split("/")[0];
      // Vite's ESM resolver respects import-only SDK exports (createRequire cannot).
      if (ownerPackages.has(packageName)) {
        const resolved = await this.resolve(id, backendImporter, { skipSelf: true });
        if (!resolved) throw new Error(`Backend test dependency is unavailable: ${id}`);
        return resolved;
      }
      // Old imports and mocks must resolve to the same canonical module as moved relative imports.
      const webSource = fileURLToPath(new URL("./src", import.meta.url));
      const runtimeSource = fileURLToPath(new URL("../backend/runtime-src", import.meta.url));
      const absolute = id.startsWith("@/") ? resolve(webSource, id.slice(2))
        : isAbsolute(id) ? id : id.startsWith(".") && importer ? resolve(dirname(importer), id) : null;
      if (!absolute) return null;
      const normalized = absolute.replaceAll("\\", "/");
      const prefix = webSource.replaceAll("\\", "/") + "/";
      const runtimePrefix = runtimeSource.replaceAll("\\", "/") + "/";
      const contractPath = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized.startsWith(runtimePrefix) ? normalized.slice(runtimePrefix.length) : null;
      if (contractPath && uiModules.includes(contractPath.endsWith(".ts") ? contractPath : contractPath + ".ts") && !(normalized.startsWith(runtimePrefix) && contractPath.replace(/\.ts$/, "") === "lib/thinking-levels")) {
        return fileURLToPath(new URL(`../shared/ui/${contractPath.slice(4).replace(/\.ts$/, "")}.ts`, import.meta.url));
      }
      if (!normalized.startsWith(prefix) || /\.test\.[jt]sx?$/.test(normalized)) return null;
      const suffix = normalized.slice(prefix.length);
      // Auth and HTTP contracts are shared, not Backend business compatibility modules.
      const sharedContracts: Record<string, string> = {
        "lib/backend-client": "backend-http-client",
        "lib/webui-auth": "webui-auth",
        "lib/webui-auth-shared": "webui-auth-shared",
        "lib/same-origin": "same-origin",
      };
      const sharedContract = sharedContracts[suffix.replace(/\.ts$/, "")];
      if (sharedContract) return fileURLToPath(new URL(`../shared/${sharedContract}.ts`, import.meta.url));
      // This Web transport remains remote; the Backend has a distinct local adapter.
      if (suffix === "lib/runtime-settings" || suffix === "lib/runtime-settings.ts") return null;
      // The Next event relay needs page metadata helpers absent from Backend task-history.
      if (suffix === "lib/task-history" || suffix === "lib/task-history.ts") return null;
      const target = join(runtimeSource, suffix.endsWith(".ts") ? suffix : `${suffix}.ts`);
      return existsSync(target) ? target : null;
    },
  }],
  resolve: {
    // Moved runtime/extension modules must share SDK and mocked package identity with Web tests.
    dedupe: ["react", "react-dom", "undici"],
    alias: {
      "@backend-runtime": fileURLToPath(new URL("../backend/runtime-src", import.meta.url)),
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
