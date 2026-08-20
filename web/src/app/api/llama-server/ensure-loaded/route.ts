import { NextResponse } from "next/server";
import { basename } from "node:path";
import { ensureLlamaServerModelLoaded } from "@/lib/llama-server-load";
import { readSettingValue } from "@/lib/host-control";
import {
  LLAMA_SERVER_SETTINGS_KEY,
  parseLlamaServerSettings,
} from "@/lib/llama-server-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { preferredId?: unknown };
  const settings = parseLlamaServerSettings(readSettingValue(LLAMA_SERVER_SETTINGS_KEY));
  const fromBody = typeof body.preferredId === "string" ? body.preferredId.trim() : "";
  const fromSettings = settings.modelFile
    ? basename(settings.modelFile.replace(/\\/g, "/")).replace(/\.gguf$/i, "")
    : "";
  const result = await ensureLlamaServerModelLoaded({
    preferredId: fromBody || fromSettings,
  });
  if (!result.ok) {
    return NextResponse.json(result, { status: 502 });
  }
  return NextResponse.json(result);
}
