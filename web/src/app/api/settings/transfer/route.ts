import { NextRequest, NextResponse } from "next/server";
import { exportSettingsBackup, importSettingsBackup, type TransferScope } from "@/lib/pi/settings-transfer";
import { isWebUiRequestAuthorized } from "@/lib/webui-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff" };

export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin) {
    return NextResponse.json({ error: "許可されない接続元です" }, { status: 403, headers: noStore });
  }
  // 未認証リクエストは JSON 本文を読み込む前に拒否する。
  const loopbackHosts = ["127.0.0.1", "localhost", "::1", "[::1]"];
  const hostHeader = req.headers.get("host");
  let headerHost = "";
  try {
    const authority = hostHeader ? new URL(`http://${hostHeader}`) : new URL(req.url);
    if (!authority.username && !authority.password) headerHost = authority.hostname;
  } catch { /* malformed Host はローカルアクセスと見なさない */ }
  const localOnly = loopbackHosts.includes(process.env.LEAFCODE_PI_BIND_HOST ?? "") &&
    loopbackHosts.includes(new URL(req.url).hostname) && loopbackHosts.includes(headerHost);
  if (!localOnly && !isWebUiRequestAuthorized(req)) {
    return NextResponse.json({ error: "設定の転送にはローカル接続またはWebUIアクセスゲートが必要です" }, { status: 403, headers: noStore });
  }
  if (Number(req.headers.get("content-length")) > 20 * 1024 * 1024) {
    return NextResponse.json({ error: "バックアップが大きすぎます" }, { status: 413, headers: noStore });
  }
  try {
    const text = await req.text();
    if (Buffer.byteLength(text, "utf8") > 20 * 1024 * 1024) return NextResponse.json({ error: "バックアップが大きすぎます" }, { status: 413, headers: noStore });
    const body = JSON.parse(text) as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "リクエスト形式が不正です" }, { status: 400, headers: noStore });
    const scope = body.action === "export" ? body.scope : (body.backup as { scope?: unknown } | null)?.scope;
    if (scope !== "settings" && scope !== "credentials" && scope !== "all") return NextResponse.json({ error: "範囲が不正です" }, { status: 400, headers: noStore });
    if (body.action === "export") {
      const backup = await exportSettingsBackup(scope as TransferScope);
      return NextResponse.json({ backup }, { headers: noStore });
    }
    if (body.action === "import") {
      const importedScope = await importSettingsBackup(body.backup);
      return NextResponse.json({ scope: importedScope }, { headers: noStore });
    }
    return NextResponse.json({ error: "操作が不正です" }, { status: 400, headers: noStore });
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    return NextResponse.json({ error: status === 400 ? (error as Error).message : "バックアップ処理に失敗しました" }, { status: status === 400 ? 400 : 500, headers: noStore });
  }
}
