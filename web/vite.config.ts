import { defineConfig, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { builtinModules } from "node:module";
import tailwind from "@tailwindcss/postcss";

const root = fileURLToPath(new URL(".", import.meta.url));
const spa = resolve(root, "src/spa");
const nodeBuiltins = new Set(builtinModules.map(name => name.replace(/^node:/, "")));
const forbidden = /(?:^node:|^(?:next(?:\/|$)|@earendil-works\/|@backend|@extensions)|(?:^|\/)(?:backend(?:-core)?|host|extensions)\/)/;
/** Existing presentation stays unchanged; SPA imports use local browser implementations. */
export function spaBoundary(): Plugin {
  const replacements: Record<string, string> = { "next/navigation": "navigation.tsx", "next/link": "link.ts", "next/image": "image.ts", "next/dynamic": "dynamic.ts" };
  return {
    name: "spa-browser-boundary", enforce: "pre",
    resolveId(id, importer) {
      if (!importer) return;
      if (replacements[id]) return resolve(spa, replacements[id]);
      if (nodeBuiltins.has(id) || forbidden.test(id.replaceAll("\\", "/"))) throw new Error(`SPA runtime dependency forbidden: ${id}`);
    },
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk") continue;
        for (const id of Object.keys(chunk.modules)) {
          const path = id.replaceAll("\\", "/");
          if (/\/node_modules\/(?:next\/|@earendil-works\/)|\/(?:backend|host|extensions)\/|\/web\/src\/app\/api\//.test(path)) throw new Error(`SPA owner/framework module forbidden: ${path}`);
        }
      }
    },
  };
}
export default defineConfig({
  root, appType: "spa", envPrefix: [], plugins: [spaBoundary()],
  resolve: { alias: { "@": resolve(root, "src"), "@shared": resolve(root, "../shared") }, dedupe: ["react", "react-dom"] },
  esbuild: { jsx: "automatic" },
  css: { postcss: { plugins: [tailwind()] } },
  build: { outDir: "dist-spa", emptyOutDir: true },
  server: { host: "127.0.0.1", proxy: { "/api": { target: process.env.LEAFCODE_SPA_API_ORIGIN ?? "http://127.0.0.1:3010", changeOrigin: false } } },
  preview: { host: "127.0.0.1", proxy: { "/api": { target: process.env.LEAFCODE_SPA_API_ORIGIN ?? "http://127.0.0.1:3010", changeOrigin: false } } },
});
