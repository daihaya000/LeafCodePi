import { NextRequest, NextResponse } from "next/server";
import {
  getProviderBaseUrl,
  jsonError,
  setProviderBaseUrl,
} from "@/lib/pi/harness";
import { isEditableBaseUrlProvider } from "@/lib/provider-endpoints";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function resolveProviderId(
  params: Promise<{ id: string }>,
): Promise<string | null> {
  try {
    return decodeURIComponent((await params).id);
  } catch {
    return null;
  }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const providerId = await resolveProviderId(params);
  if (!providerId || !isEditableBaseUrlProvider(providerId)) {
    return NextResponse.json(
      { error: "API URL を変更できるプロバイダーではありません" },
      { status: 400 },
    );
  }
  return NextResponse.json({ baseUrl: getProviderBaseUrl(providerId) });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const providerId = await resolveProviderId(params);
  if (!providerId || !isEditableBaseUrlProvider(providerId)) {
    return NextResponse.json(
      { error: "API URL を変更できるプロバイダーではありません" },
      { status: 400 },
    );
  }
  const body = (await req.json().catch(() => null)) as
    | { baseUrl?: unknown }
    | null;
  if (typeof body?.baseUrl !== "string") {
    return NextResponse.json({ error: "baseUrl が不正です" }, { status: 400 });
  }
  try {
    setProviderBaseUrl(providerId, body.baseUrl);
    return NextResponse.json({ baseUrl: getProviderBaseUrl(providerId) });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
