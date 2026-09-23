import { NextRequest, NextResponse } from "next/server";
import { normalizeJevModelSettings } from "@/lib/jev-model-settings";
import { getJevModelSettingsDto, saveJevModelSettings } from "@/lib/pi/jev-model-config";
import { listJevModels } from "@/lib/pi/harness";
import { jevModelKey, type JevCatalogModel } from "@/lib/jev-model-catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function settingsDto(refresh = false, knownModels?: JevCatalogModel[]) {
  const [dto, models] = await Promise.all([
    getJevModelSettingsDto(),
    knownModels ?? listJevModels(refresh).catch(() => []),
  ]);
  return { ...dto, models };
}

export async function GET(req?: NextRequest) {
  try {
    return NextResponse.json(await settingsDto(req?.nextUrl.searchParams.get("refresh") === "1"));
  } catch {
    return NextResponse.json({ error: "Jevモデル設定を取得できません" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const origin = req.headers.get("origin");
  if ((origin && origin !== req.nextUrl.origin) || req.headers.get("sec-fetch-site") === "cross-site") {
    return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
  }
  if (req.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
    return NextResponse.json({ error: "JSONが必要です" }, { status: 415 });
  }
  const raw = await req.text();
  if (raw.length > 16_384) return NextResponse.json({ error: "設定が長すぎます" }, { status: 400 });
  let settings: ReturnType<typeof normalizeJevModelSettings>;
  let apiKey: string | null | undefined;
  let knownModels: JevCatalogModel[] | undefined;
  try {
    const body = JSON.parse(raw);
    settings = normalizeJevModelSettings(body?.settings);
    apiKey = body.apiKey;
    if (apiKey !== undefined && apiKey !== null) {
      if (typeof apiKey !== "string" || apiKey.length > 4096 || !/^[\x21-\x7e]+$/.test(apiKey.trim())) {
        throw new Error("APIキーが不正です");
      }
      apiKey = apiKey.trim();
    }
    if (settings.provider === "registered") {
      if (apiKey !== undefined) throw new Error("既存プロバイダーの認証をここで変更することはできません");
      const models = knownModels = await listJevModels().catch(() => []);
      const selected = settings.enabledModels ?? [settings.registeredModel!];
      if (selected.some((ref) => !models.some((model) => model.providerEnabled !== false && jevModelKey(model) === jevModelKey(ref)))) {
        throw new Error("有効にしたJevモデルは未検出、またはアカウントが無効です");
      }
      if (settings.enabledModels) {
        const keys = new Set(settings.enabledModels.map(jevModelKey));
        const rows = new Map<string, typeof models>();
        for (const model of models) {
          const rowKey = model.integrated ? model.providerId : model.accountId ? `${model.accountId}::${model.providerId}` : model.providerId;
          const row = rows.get(rowKey) ?? [];
          row.push(model);
          rows.set(rowKey, row);
        }
        settings.enabledModels = [...rows.values()].flat().flatMap((model) => {
          if (!keys.delete(jevModelKey(model))) return [];
          return [{ providerId: model.providerId, modelId: model.modelId, ...(model.accountId ? { accountId: model.accountId } : {}) }];
        });
        settings.registeredModel = settings.enabledModels[0];
      }
    }
  } catch (error) {
    // JSON parser messages can contain submitted secrets; only expose our validation errors.
    return NextResponse.json({ error: error instanceof SyntaxError ? "JSONが不正です" : error instanceof Error ? error.message : "設定が不正です" }, { status: 400 });
  }
  try {
    await saveJevModelSettings(settings, apiKey);
    return NextResponse.json(await settingsDto(false, knownModels));
  } catch {
    return NextResponse.json({ error: "Jevモデル設定を保存できません" }, { status: 500 });
  }
}
