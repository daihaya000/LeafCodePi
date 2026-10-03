import { NextResponse } from "next/server";
import { basename } from "node:path";
import { ensureLlamaServerModelLoaded, LLAMA_ENSURE_LOADED_WAIT_MS } from "@/lib/llama-server-load";
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
  // The load itself is not bound to this request: llama-server keeps loading
  // after the client goes away. Cap the wait so the BFF worker is released even
  // when nothing calls back, and stop polling as soon as the client aborts.
  const result = await ensureLlamaServerModelLoaded({
    preferredId: fromBody || fromSettings,
    waitMs: LLAMA_ENSURE_LOADED_WAIT_MS,
    signal: req.signal,
  });
  if (result.pending) {
    return NextResponse.json({ ok: true, pending: true, ...(result.modelId ? { modelId: result.modelId } : {}) });
  }
  if (!result.ok) {
    return NextResponse.json(result, { status: 502 });
  }
  return NextResponse.json(result);
}
