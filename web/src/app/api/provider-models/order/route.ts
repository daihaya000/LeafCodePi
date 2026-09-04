import { NextResponse } from "next/server";
import { jsonError, saveProviderModelsOrder } from "@/lib/pi/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ProviderModelsOrderBody = {
  providerOrder?: string[];
  modelOrder?: Record<string, string[]>;
  accountModelOrder?: Record<string, Record<string, string[]>>;
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStringArrayRecord(value: unknown): value is Record<string, string[]> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.values(value).every(isStringArray),
  );
}

function isAccountModelOrder(value: unknown): value is Record<string, Record<string, string[]>> {
  return Boolean(
    value === undefined ||
      (value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.values(value).every(isStringArrayRecord)),
  );
}

export async function PATCH(req: Request) {
  try {
    const raw = await req.json().catch(() => null);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return NextResponse.json({ error: "invalid order payload" }, { status: 400 });
    }
    const body = raw as ProviderModelsOrderBody;
    if (
      (body.providerOrder !== undefined && !isStringArray(body.providerOrder)) ||
      (body.modelOrder !== undefined && !isStringArrayRecord(body.modelOrder)) ||
      !isAccountModelOrder(body.accountModelOrder)
    ) {
      return NextResponse.json({ error: "invalid order payload" }, { status: 400 });
    }
    await saveProviderModelsOrder({
      providerOrder: body.providerOrder,
      modelOrder: body.modelOrder,
      accountModelOrder: body.accountModelOrder,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
