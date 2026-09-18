import type { NextConfig } from "next";
import { join } from "node:path";

const nextConfig: NextConfig = {
  distDir: ".next",
  outputFileTracingRoot: join(__dirname),
  // 型チェックは scripts/build-web.mjs が `tsc --noEmit` を並列実行して
  // 代替する（ビルド内の直列 15 秒を削る）。型エラーはそのゲートで
  // ビルドを失敗させる。
  typescript: { ignoreBuildErrors: true },
  experimental: {
    optimizePackageImports: ["lucide-react"],
  },
  serverExternalPackages: [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-tui",
    "@silvia-odwyer/photon-node",
    // Loads `sqlite` (Cursor IDE state.vscdb) through an optional dynamic import;
    // bundling it makes webpack warn about the unresolvable module.
    "@rahularya01/pi-cursor",
    "pi-commandcode-provider",
    "jiti",
  ],
};

export default nextConfig;
