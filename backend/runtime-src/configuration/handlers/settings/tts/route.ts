import {  ConfigurationRequest as NextRequest, ConfigurationResponse as NextResponse  } from "../../../http";
import { isConfigurationRequestAuthorized as isWebUiRequestAuthorized } from "../../../http";
import { isSafeUnauthenticatedTtsUrl, readTtsConfig, writeTtsConfig, ttsHostCapabilities, type TtsConfigDto, type TtsSettingsDto } from "@/lib/tts-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function dto(config = readTtsConfig()): TtsSettingsDto {
  return { ...config, ...ttsHostCapabilities() };
}

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
}

export async function GET() {
  return NextResponse.json(dto(), { headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Partial<TtsConfigDto> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "JSON オブジェクトが必要です" }, { status: 400 });
  }
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled は boolean です" }, { status: 400 });
  }
  if (body.voice !== undefined && typeof body.voice !== "string") {
    return NextResponse.json({ error: "voice は string です" }, { status: 400 });
  }
  if (body.url !== undefined && typeof body.url !== "string") {
    return NextResponse.json({ error: "url は string です" }, { status: 400 });
  }
  if (body.rate !== undefined && (typeof body.rate !== "number" || !Number.isFinite(body.rate))) {
    return NextResponse.json({ error: "rate は number です" }, { status: 400 });
  }
  let allowCustomUrl: boolean | undefined;
  if (typeof body.url === "string") {
    allowCustomUrl = body.url.trim() !== "" && !isSafeUnauthenticatedTtsUrl(body.url);
    if (allowCustomUrl && !isWebUiRequestAuthorized(req)) return unauthorized();
  }
  return NextResponse.json(dto(writeTtsConfig(body, { allowCustomUrl })), { headers: { "Cache-Control": "no-store" } });
}
