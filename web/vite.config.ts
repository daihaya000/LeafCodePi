import { defineConfig, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { builtinModules } from "node:module";
import tailwind from "@tailwindcss/postcss";
import { checkBrowserBoundary, checkProductionFile, checkSpecifier, dependencyReferences } from "../scripts/production-boundary.mjs";

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
    configResolved(config) { production = config.command === "build" && resolve(config.root) === resolve(root); },
    buildStart() { if (production) checkBrowserBoundary(checkout); },
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
          for (const edge of dependencyReferences(chunk.code, chunk.fileName, undefined, { kind: "browser", bundled: true })) checkSpecifier(edge.specifier, "browser", chunk.fileName);
        }
      }
    },
  };
}
export default defineConfig({
  root, appType: "spa", envPrefix: [], plugins: [spaBoundary()],
  // Build workers supply display-only Git metadata; unbuilt development has no build label.
  define: { "process.env.NEXT_PUBLIC_LEAFCODE_PI_BUILD_COMMIT": '""', "process.env.NEXT_PUBLIC_LEAFCODE_PI_BUILD_COMMIT_DATE": '""' },
  resolve: {
    // Exact neutral bindings precede the generic @ alias. Legacy bridges must
    // never be visited by SPA builds; bare next/* imports now fail closed.
    alias: {
      "@/platform/navigation": resolve(spa, "navigation.tsx"),
      "@/platform/link": resolve(spa, "link.ts"),
      "@/platform/image": resolve(spa, "image.ts"),
      "@/platform/dynamic": resolve(spa, "dynamic.ts"),
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
  build: { outDir: "dist-spa", emptyOutDir: true },
  server: { host: "127.0.0.1", proxy },
  preview: { host: "127.0.0.1", proxy },
});
