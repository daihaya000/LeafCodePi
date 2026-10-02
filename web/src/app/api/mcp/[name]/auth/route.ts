/**
 * GET/POST/DELETE /api/mcp/:name/auth — inspect and manage MCP credentials.
 *
 * Production forwards all authentication operations to Backend. Credential and
 * callback/code inputs are never included in a response or written to mcp.json.
 */
import { NextRequest, NextResponse } from "next/server";
import { publicMcpAuthSnapshot } from "@shared/mcp-auth-snapshot.mjs";
import { readMcpAuthStatusOnBackend, saveMcpBearerAuthOnBackend, saveMcpHeadersAuthOnBackend, removeMcpAuthOnBackend, startMcpOAuthAuthOnBackend, completeMcpOAuthAuthOnBackend } from "@/lib/backend-client";
import { parseMcpHeadersSaveRequest, publicMcpHeadersSaveResult } from "@shared/mcp-headers-save-request.mjs";
import { saveMcpHeadersAuth } from "@/lib/mcp-headers-admin";
import { parseMcpAuthRemoveRequest, publicMcpAuthRemoveResult } from "@shared/mcp-auth-remove-request.mjs";
import { removeMcpAuth } from "@/lib/mcp-auth-remove-admin";
import { parseMcpOAuthStartRequest, publicMcpOAuthStartResult } from "@shared/mcp-oauth-start-request.mjs";
import { startMcpOAuthAuth } from "@/lib/mcp-oauth-start-admin";
import { parseMcpOAuthCompleteRequest, publicMcpOAuthCompleteResult } from "@shared/mcp-oauth-complete-request.mjs";
import { completeMcpOAuthAuth } from "@/lib/mcp-oauth-complete-admin";
import { parseMcpBearerSaveRequest, publicMcpBearerSaveResult } from "@shared/mcp-bearer-save-request.mjs";
import { saveMcpBearerAuth } from "@/lib/mcp-bearer-admin";
import { readMcpAuthStatus } from "@/lib/mcp-auth-status";
import { localRuntimeBlocked } from "@/lib/pi/runtime-ownership";
import { McpError, mcpErrorStatus } from "@/lib/mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ name: string }> };
type AuthMethod = "bearer" | "headers" | "oauth";

type AuthBody = {
  type?: unknown;
  action?: unknown;
  token?: unknown;
  headers?: unknown;
  input?: unknown;
};

function readName(rawName: string): string {
  try {
    return decodeURIComponent(rawName);
  } catch {
    throw new McpError("invalid-name", "名前が不正です");
  }
}

function bodyObject(body: unknown): AuthBody {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new McpError("invalid-auth", "認証リクエストが不正です");
  }
  return body as AuthBody;
}

function methodFromBody(body: AuthBody, fallback: AuthMethod): AuthMethod {
  const method = body.type ?? body.action;
  if (method === "bearer" || method === "headers" || method === "oauth") return method;
  return fallback;
}

export async function GET(_req: NextRequest, context: RouteContext) {
  try {
    const { name: rawName } = await context.params;
    const name = readName(rawName).trim();
    if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) {
      throw new McpError("invalid-name", "名前が不正です");
    }
    if (localRuntimeBlocked()) {
      const forwarded = await readMcpAuthStatusOnBackend(name);
      if (!forwarded.ok) {
        return NextResponse.json({ error: "BackendでMCP認証状態を取得できません" }, { status: forwarded.status ?? 502 });
      }
      const snapshot = publicMcpAuthSnapshot(forwarded.body);
      if (!snapshot || snapshot.name !== name) {
        return NextResponse.json({ error: "BackendのMCP応答が不正です" }, { status: 502 });
      }
      return NextResponse.json(snapshot);
    }
    return NextResponse.json(await readMcpAuthStatus(name));
  } catch (error) {
    return NextResponse.json(
      { error: "MCP認証状態の取得に失敗しました" },
      { status: mcpErrorStatus(error) },
    );
  }
}

export async function POST(req: NextRequest, context: RouteContext) {
  let name: string;
  try {
    const { name: rawName } = await context.params;
    name = readName(rawName);
    let parsedBody: unknown;
    try {
      parsedBody = await req.json();
    } catch {
      throw new McpError("invalid-auth", "認証リクエストが不正です");
    }
    const body = bodyObject(parsedBody);
    const method = methodFromBody(body, "bearer");

    if (method === "bearer") {
      const parsed = parseMcpBearerSaveRequest(body);
      const canonicalName = name.trim();
      if (!parsed.ok) throw new McpError("invalid-auth", "Bearer認証リクエストが不正です");
      if (!canonicalName || canonicalName.includes("/") || canonicalName.includes("\\") || canonicalName.includes("..")) {
        throw new McpError("invalid-name", "名前が不正です");
      }
      if (localRuntimeBlocked()) {
        const forwarded = await saveMcpBearerAuthOnBackend(canonicalName, parsed.value).catch(() => {
          throw new McpError("auth-unavailable", "BackendでBearer認証情報を保存できません");
        });
        if (!forwarded.ok) {
          const status = forwarded.status && forwarded.status >= 400 && forwarded.status <= 599 ? forwarded.status : 502;
          return NextResponse.json({ error: "BackendでBearer認証情報を保存できません" }, { status });
        }
        const result = publicMcpBearerSaveResult(forwarded.body);
        if (!result || result.auth.name !== canonicalName) {
          return NextResponse.json({ error: "BackendのMCP応答が不正です" }, { status: 502 });
        }
        return NextResponse.json(result);
      }
      // Development keeps local ownership, using the same guarded operation as Backend.
      try { return NextResponse.json(await saveMcpBearerAuth(canonicalName, parsed.value)); }
      catch (error) {
        return NextResponse.json({ error: "Bearer認証情報を保存できませんでした" }, { status: mcpErrorStatus(error) });
      }
    }

    if (method === "headers") {
      const parsed = parseMcpHeadersSaveRequest(body);
      const canonicalName = name.trim();
      if (!parsed.ok) throw new McpError("invalid-auth", "HTTPヘッダー認証リクエストが不正です");
      if (!canonicalName || canonicalName.includes("/") || canonicalName.includes("\\") || canonicalName.includes("..")) {
        throw new McpError("invalid-name", "名前が不正です");
      }
      if (localRuntimeBlocked()) {
        const forwarded = await saveMcpHeadersAuthOnBackend(canonicalName, parsed.value).catch(() => {
          throw new McpError("auth-unavailable", "BackendでHTTPヘッダー認証情報を保存できません");
        });
        if (!forwarded.ok) {
          const status = forwarded.status && forwarded.status >= 400 && forwarded.status <= 599 ? forwarded.status : 502;
          return NextResponse.json({ error: "BackendでHTTPヘッダー認証情報を保存できません" }, { status });
        }
        const result = publicMcpHeadersSaveResult(forwarded.body);
        if (!result || result.auth.name !== canonicalName) {
          return NextResponse.json({ error: "BackendのMCP応答が不正です" }, { status: 502 });
        }
        return NextResponse.json(result);
      }
      try { return NextResponse.json(await saveMcpHeadersAuth(canonicalName, parsed.value)); }
      catch (error) {
        return NextResponse.json({ error: "HTTPヘッダー認証情報を保存できませんでした" }, { status: mcpErrorStatus(error) });
      }
    }

    const action = body.action ?? "start";
    if (action === "start") {
      const parsed = parseMcpOAuthStartRequest(body);
      const canonicalName = name.trim();
      if (!parsed.ok) throw new McpError("invalid-auth", "OAuth開始リクエストが不正です");
      if (!canonicalName || canonicalName.includes("/") || canonicalName.includes("\\") || canonicalName.includes("..")) {
        throw new McpError("invalid-name", "名前が不正です");
      }
      if (localRuntimeBlocked()) {
        const forwarded = await startMcpOAuthAuthOnBackend(canonicalName, parsed.value).catch(() => {
          throw new McpError("auth-unavailable", "BackendでOAuth認証を開始できません");
        });
        if (!forwarded.ok) {
          const status = forwarded.status && forwarded.status >= 400 && forwarded.status <= 599 ? forwarded.status : 502;
          return NextResponse.json({ error: "BackendでOAuth認証を開始できません" }, { status });
        }
        const result = publicMcpOAuthStartResult(forwarded.body);
        if (!result || result.name !== canonicalName) {
          return NextResponse.json({ error: "BackendのMCP応答が不正です" }, { status: 502 });
        }
        return NextResponse.json(result);
      }
      try { return NextResponse.json(await startMcpOAuthAuth(canonicalName, parsed.value)); }
      catch (error) {
        return NextResponse.json({ error: "OAuth認証を開始できませんでした" }, { status: mcpErrorStatus(error) });
      }
    }
    if (action === "complete") {
      const parsed = parseMcpOAuthCompleteRequest(body);
      const canonicalName = name.trim();
      if (!parsed.ok) throw new McpError("invalid-auth", "OAuth完了リクエストが不正です");
      if (!canonicalName || canonicalName.includes("/") || canonicalName.includes("\\") || canonicalName.includes("..")) {
        throw new McpError("invalid-name", "名前が不正です");
      }
      if (localRuntimeBlocked()) {
        const forwarded = await completeMcpOAuthAuthOnBackend(canonicalName, parsed.value).catch(() => {
          throw new McpError("auth-unavailable", "BackendでOAuth認証を完了できません");
        });
        if (!forwarded.ok) {
          const status = forwarded.status && forwarded.status >= 400 && forwarded.status <= 599 ? forwarded.status : 502;
          return NextResponse.json({ error: "BackendでOAuth認証を完了できません" }, { status });
        }
        const result = publicMcpOAuthCompleteResult(forwarded.body);
        if (!result || result.auth.name !== canonicalName) {
          return NextResponse.json({ error: "BackendのMCP応答が不正です" }, { status: 502 });
        }
        return NextResponse.json(result);
      }
      try { return NextResponse.json(await completeMcpOAuthAuth(canonicalName, parsed.value)); }
      catch (error) {
        return NextResponse.json({ error: "OAuth認証を完了できませんでした。期限切れの場合は認証開始からやり直してください" }, { status: mcpErrorStatus(error) });
      }
    }
    throw new McpError("invalid-auth", "OAuth操作が不正です");
  } catch (error) {
    return NextResponse.json(
      { error: "MCP認証情報の保存に失敗しました" },
      { status: mcpErrorStatus(error) },
    );
  }
}

export async function DELETE(req: NextRequest, context: RouteContext) {
  try {
    const { name: rawName } = await context.params;
    const name = readName(rawName).trim();
    if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) {
      throw new McpError("invalid-name", "名前が不正です");
    }
    let body: AuthBody = {};
    try {
      const text = await req.text();
      if (text.length > 4096) throw new Error("Body too large");
      if (text.trim()) body = bodyObject(JSON.parse(text));
    } catch {
      throw new McpError("invalid-auth", "認証削除リクエストが不正です");
    }
    const parsed = parseMcpAuthRemoveRequest(body);
    if (!parsed.ok) throw new McpError("invalid-auth", "認証削除リクエストが不正です");
    if (localRuntimeBlocked()) {
      const forwarded = await removeMcpAuthOnBackend(name, parsed.value).catch(() => {
        throw new McpError("auth-unavailable", "BackendでMCP認証情報を削除できません");
      });
      if (!forwarded.ok) {
        const status = forwarded.status && forwarded.status >= 400 && forwarded.status <= 599 ? forwarded.status : 502;
        return NextResponse.json({ error: "BackendでMCP認証情報を削除できません" }, { status });
      }
      const result = publicMcpAuthRemoveResult(forwarded.body);
      if (!result || result.auth.name !== name) {
        return NextResponse.json({ error: "BackendのMCP応答が不正です" }, { status: 502 });
      }
      return NextResponse.json(result);
    }
    // Development uses the same guarded owner operation for all deletion methods.
    return NextResponse.json(await removeMcpAuth(name, parsed.value));
  } catch (error) {
    return NextResponse.json(
      { error: "MCP認証情報の削除に失敗しました" },
      { status: mcpErrorStatus(error) },
    );
  }
}
