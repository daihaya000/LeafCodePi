import type { NextConfig } from "next";
import { join } from "node:path";

const nextConfig: NextConfig = {
  distDir: ".next",
  outputFileTracingRoot: join(__dirname),
  serverExternalPackages: [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-tui",
    "@silvia-odwyer/photon-node",
  ],
};

export default nextConfig;
