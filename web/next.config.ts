import type { NextConfig } from "next";
import { existsSync } from "node:fs";
import { join } from "node:path";

// The production mirror contains shared/ locally; development uses the checkout sibling.
const projectRoot = existsSync(join(__dirname, "shared")) ? __dirname : join(__dirname, "..");
const nextConfig: NextConfig = {
  distDir: ".next",
  outputFileTracingRoot: projectRoot,
  turbopack: { root: projectRoot },
  // 型チェックは scripts/build-web.mjs が `tsc --noEmit` を並列実行して
  // 代替する（ビルド内の直列 15 秒を削る）。型エラーはそのゲートで
  // ビルドを失敗させる。
  typescript: { ignoreBuildErrors: true },
  experimental: {
    optimizePackageImports: ["lucide-react"],
  },
};

export default nextConfig;
