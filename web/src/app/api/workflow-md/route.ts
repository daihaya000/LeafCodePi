import { NextResponse } from "next/server";
import {
  errorStatus,
  readGlobalWorkflowMd,
  writeGlobalWorkflowMd,
} from "@/lib/agents-md";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(readGlobalWorkflowMd());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "WORKFLOW.mdの読み込みに失敗しました" },
      { status: errorStatus(error) },
    );
  }
}

export async function PATCH(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエスト本文が不正です" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "content は文字列で指定してください" }, { status: 400 });
  }
  const content = (body as { content?: unknown }).content;
  if (typeof content !== "string") {
    return NextResponse.json({ error: "content は文字列で指定してください" }, { status: 400 });
  }

  try {
    return NextResponse.json({ ok: true, ...writeGlobalWorkflowMd(content) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "WORKFLOW.mdの保存に失敗しました" },
      { status: errorStatus(error) },
    );
  }
}
