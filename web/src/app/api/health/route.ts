import { NextRequest, NextResponse } from "next/server";
import { getHealth, jsonError } from "@/lib/pi/harness";
import { isWebUiRequestAuthorized, webUiAuthRequired } from "@/lib/webui-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `/api/health` stays public so the host can probe readiness without a token,
 * but absolute paths (the OS user name) and provider-sync warnings are not part
 * of that contract. Authenticated WebUI callers still get the full payload.
 */
function publicHealth<T extends { dataDir?: string; warnings?: string[] }>(
  health: T,
): Omit<T, "dataDir" | "warnings"> {
  const rest = { ...health };
  delete rest.dataDir;
  delete rest.warnings;
  return rest;
}

export async function GET(req: NextRequest) {
  try {
    const health = await getHealth();
    if (!webUiAuthRequired() || isWebUiRequestAuthorized(req)) {
      return NextResponse.json(health);
    }
    return NextResponse.json(publicHealth(health));
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
