import { NextResponse } from "next/server";
import { readSettingValue, writeSettingValue } from "@/lib/host-control";
import {
  isLlamaServerSettings,
  LLAMA_SERVER_SETTINGS_KEY,
  parseLlamaServerSettings,
} from "@/lib/llama-server-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const value = readSettingValue(LLAMA_SERVER_SETTINGS_KEY);
  return NextResponse.json({ value, parsed: parseLlamaServerSettings(value) });
}

export async function PUT(req: Request) {
  const body = (await req.json().catch(() => null)) as { value?: unknown } | null;
  if (!body || typeof body.value !== "string") {
    return NextResponse.json({ error: "value must be a JSON string" }, { status: 400 });
  }
  try {
    const parsed: unknown = JSON.parse(body.value);
    if (!isLlamaServerSettings(parsed)) {
      return NextResponse.json({ error: "llama-server-config has an invalid shape" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "llama-server-config must be JSON" }, { status: 400 });
  }
  writeSettingValue(LLAMA_SERVER_SETTINGS_KEY, body.value);
  return NextResponse.json({ ok: true });
}
