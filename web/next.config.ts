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
    "pi-commandcode-provider",
    "jiti",
  ],
};

export default nextConfig;
