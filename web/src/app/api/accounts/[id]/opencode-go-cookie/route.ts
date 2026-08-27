import { NextRequest, NextResponse } from "next/server";
import { accountAuthPath, getAccount, resolvePiAgentDir } from "@/lib/accounts";
import {
  deleteAccountOpenCodeCookieFile,
  saveAccountOpenCodeCookieFile,
} from "@/lib/codexbar/browser-cookies";
import {
  readAccountOpenCodeGoWorkspace,
  writeAccountOpenCodeGoWorkspace,
} from "@/lib/codexbar/providers/opencode-go";
import { invalidateCachedUsage } from "@/lib/codexbar/cache";
import { clearProviderCache } from "@/lib/codexbar/provider-cache";
import { jsonError } from "@/lib/pi/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

function requireAccount(id: string): void {
  const account = getAccount(id);
  if (!account)
    throw Object.assign(new Error("アカウントが見つかりません"), {
      status: 404,
    });
  if (!account.providers.includes("opencode-go")) {
    throw Object.assign(
      new Error("このアカウントは OpenCode Go に対応していません"),
      { status: 400 },
    );
  }
}

export async function GET(_req: NextRequest, context: Context) {
  const { id } = await context.params;
  try {
    requireAccount(id);
    const agentDir = await resolvePiAgentDir();
    return NextResponse.json({
      workspaceId: readAccountOpenCodeGoWorkspace(
        accountAuthPath(id, agentDir),
      ),
    });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}

/** OpenCode Go の Netscape cookie と任意の workspace ID をアカウントへ保存する。 */
export async function POST(req: NextRequest, context: Context) {
  const { id } = await context.params;
  try {
    requireAccount(id);
    const body = (await req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body.cookies !== "string") {
      return NextResponse.json(
        { error: "cookies は文字列で指定してください" },
        { status: 400 },
      );
    }
    const workspaceId = body.workspaceId;
    if (
      workspaceId !== undefined &&
      (typeof workspaceId !== "string" || !workspaceId.trim())
    ) {
      return NextResponse.json(
        { error: "workspaceId は空でない文字列で指定してください" },
        { status: 400 },
      );
    }
    const agentDir = await resolvePiAgentDir();
    const authPath = accountAuthPath(id, agentDir);
    saveAccountOpenCodeCookieFile(authPath, body.cookies);
    if (typeof workspaceId === "string")
      writeAccountOpenCodeGoWorkspace(authPath, workspaceId.trim());
    invalidateCachedUsage();
    clearProviderCache(`account:${id}:opencode-go`);
    return NextResponse.json({ ok: true, configured: true });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(_req: NextRequest, context: Context) {
  const { id } = await context.params;
  try {
    requireAccount(id);
    const agentDir = await resolvePiAgentDir();
    deleteAccountOpenCodeCookieFile(accountAuthPath(id, agentDir));
    invalidateCachedUsage();
    clearProviderCache(`account:${id}:opencode-go`);
    return NextResponse.json({ ok: true, configured: false });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
