import type { NextConfig } from "next";
import { join } from "node:path";

const nextConfig: NextConfig = {
  distDir: ".next",
  outputFileTracingRoot: join(__dirname),
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
