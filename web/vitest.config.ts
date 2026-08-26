import { configDefaults, defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

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
    // 24コア機でもテスト全体の実行時間は worker 数に応じて頭打ちになる
    // （collaboration-room が協調処理で subprocess を多用し CPU 競合を起こす）。
    // 実測: デフォルト(24) 27.5s → 8 で 24.9s（約9%改善）。
    maxWorkers: 8,
    // シェル環境の NODE_ENV=production 継承で production react ビルドが読まれ、
    // React.act が未定義になるためテストでは強制上書きする。
    env: {
      NODE_ENV: "test",
    },
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "../extensions/**/*.test.ts"],
    exclude: [
      ...configDefaults.exclude,
      "../extensions/**/node_modules/**",
      "../extensions/leafcode-memory/tests/**",
    ],
  },
});
