import { defineConfig, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { builtinModules } from "node:module";
import tailwind from "@tailwindcss/postcss";
import { checkBrowserBoundary, checkProductionFile, checkSpecifier, dependencyReferences } from "../scripts/production-boundary.mjs";
import { browserMetadataVerifier, browserSourceWithoutMapDirectives } from "../scripts/browser-runtime-metadata.mjs";
import { readFileSync } from "node:fs";

const root = fileURLToPath(new URL(".", import.meta.url));
const spa = resolve(root, "src/spa");
const apiOrigin = process.env.LEAFCODE_SPA_API_ORIGIN ?? "http://127.0.0.1:3010";
const proxy = { "/api": { target: apiOrigin, changeOrigin: false }, "^/webui-bootstrap\\.json(?:\\?|$)": { target: apiOrigin, changeOrigin: false } };
const nodeBuiltins = new Set(builtinModules.map(name => name.replace(/^node:/, "")));
const forbidden = /(?:^node:|^(?:next(?:\/|$)|@earendil-works\/|@backend|@extensions)|(?:^|\/)(?:backend(?:-core)?|host|extensions)\/)/;
/** Existing presentation stays unchanged; SPA imports use local browser implementations. */
export function spaBoundary(): Plugin {
  let production = false;
  const checkout = resolve(root, "..");
  return {
    name: "spa-browser-boundary", enforce: "pre",
    configResolved(config) {
      production = config.command === "build" && resolve(config.root) === resolve(root);
      if (production) config.build.sourcemap = "hidden";
    },
    buildStart() { if (production) checkBrowserBoundary(checkout); },
    outputOptions(options) {
      if (production) return { ...options, sourcemap: "hidden" };
    },
    load(id) {
      if (!production || id.startsWith("\0") || id.includes("?") || !/\.[cm]?[jt]sx?$/.test(id)) return;
      checkProductionFile(id, checkout, "browser", { packageFile: id.replaceAll("\\", "/").includes("/node_modules/") });
      // Establish compiler maps from actual source bytes; upstream maps cannot
      // impersonate one of the byte-pinned metadata sites.
      return { code: browserSourceWithoutMapDirectives(readFileSync(id, "utf8"), id), map: null };
    },
    configureServer(server) {
      if (!server.config.server.middlewareMode) throw new Error("Use the authenticated gateway development entry, not a standalone Vite listener");
    },
    resolveId(id, importer) {
      if (!importer) return;
      if (nodeBuiltins.has(id) || forbidden.test(id.replaceAll("\\", "/"))) throw new Error(`SPA runtime dependency forbidden: ${id}`);
    },
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk") continue;
        for (const id of Object.keys(chunk.modules)) {
          const path = id.replaceAll("\\", "/");
          if (production && !id.startsWith("\0")) {
            const file = id.split("?")[0];
            checkProductionFile(file, checkout, "browser", { packageFile: path.includes("/node_modules/") });
          }
          if (/\/node_modules\/(?:next\/|@earendil-works\/)|\/(?:backend|host|extensions)\/|\/web\/src\/app\/api\/|\/src\/platform\/(?:navigation|link|image|dynamic)\.ts$/.test(path)) throw new Error(`SPA owner/framework module forbidden: ${path}`);
        }
        if (production) {
          const allowMetadata = browserMetadataVerifier(chunk);
          for (const edge of dependencyReferences(chunk.code, chunk.fileName, undefined, { kind: "browser", bundled: true, allowMetadata })) checkSpecifier(edge.specifier, "browser", chunk.fileName);
        }
      }
      // Compiler provenance is private gate input, never a published browser asset.
      if (production) for (const name of Object.keys(bundle)) if (name.endsWith(".js.map")) delete bundle[name];
    },
  };
}
export default defineConfig({
  root, appType: "spa", envPrefix: [], plugins: [spaBoundary()],
  // Build workers supply display-only Git metadata; unbuilt development has no build label.
  define: {
    "process.env.NEXT_PUBLIC_LEAFCODE_PI_BUILD_COMMIT": JSON.stringify(process.env.NEXT_PUBLIC_LEAFCODE_PI_BUILD_COMMIT ?? ""),
    "process.env.NEXT_PUBLIC_LEAFCODE_PI_BUILD_COMMIT_DATE": JSON.stringify(process.env.NEXT_PUBLIC_LEAFCODE_PI_BUILD_COMMIT_DATE ?? ""),
  },
  resolve: {
    // Exact neutral bindings precede the generic @ alias. Legacy bridges must
    // never be visited by SPA builds; bare next/* imports now fail closed.
    alias: {
      "@/lib/pi/messages": resolve(root, "../shared/ui/pi/messages.ts"),
      "@/lib/tts-backends": resolve(root, "../shared/ui/tts-backends.ts"),
      "@/lib/host-launch-hints": resolve(root, "../shared/ui/host-launch-hints.ts"),
      "@shared/llama-server-settings.mjs": resolve(root, "../shared/ui/llama-server-settings.mjs"),
      "@": resolve(root, "src"), "@shared": resolve(root, "../shared"),
    },
    dedupe: ["react", "react-dom"],
  },
  esbuild: { jsx: "automatic" },
  css: { postcss: { plugins: [tailwind()] } },
  build: { outDir: "dist-spa", emptyOutDir: true, sourcemap: "hidden" },
  server: { host: "127.0.0.1", proxy },
  preview: { host: "127.0.0.1", proxy },
});
