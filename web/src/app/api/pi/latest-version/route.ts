import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PI_PACKAGES = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"];
const STABLE_VERSION = /^\d+\.\d+\.\d+$/;
const NPM_REGISTRY = "https://registry.npmjs.org";

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

async function latestVersion(packageName: string): Promise<string> {
  const encodedName = packageName.replace("/", "%2f");
  const response = await fetch(`${NPM_REGISTRY}/${encodedName}/latest`, {
    cache: "no-store",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new Error(`npm registry returned HTTP ${response.status} for ${packageName}`);
  }

  const data = (await response.json().catch(() => null)) as { version?: unknown } | null;
  if (typeof data?.version !== "string" || !STABLE_VERSION.test(data.version)) {
    throw new Error(`${packageName} does not have a stable latest version`);
  }
  return data.version;
}

export async function GET() {
  try {
    const versions = await Promise.all(PI_PACKAGES.map(latestVersion));
    if (versions[0] !== versions[1]) {
      throw new Error("Pi SDK と Pi AI の配信バージョンが一致しません");
    }
    return json({ version: versions[0], checkedAt: Date.now() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "npm registryへの接続に失敗しました";
    return json({ error: `Piの最新バージョンを取得できません: ${message}` }, 502);
  }
}
