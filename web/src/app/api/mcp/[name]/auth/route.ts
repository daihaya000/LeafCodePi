/**
 * GET/POST/DELETE /api/mcp/:name/auth — inspect and manage MCP credentials.
 *
 * Secret material is accepted only for bearer/header save operations and is
 * forwarded to the MCP adapter's OS credential-store bridge. It is never
 * included in a response or written to mcp.json.
 */
import { NextRequest, NextResponse } from "next/server";
import { reloadLiveSessionsContext } from "@/lib/live-context";
import { publicMcpAuthSnapshot } from "@shared/mcp-auth-snapshot.mjs";
import { readMcpAuthStatusOnBackend, saveMcpBearerAuthOnBackend, saveMcpHeadersAuthOnBackend, removeMcpAuthOnBackend, startMcpOAuthAuthOnBackend } from "@/lib/backend-client";
import { parseMcpHeadersSaveRequest, publicMcpHeadersSaveResult } from "@shared/mcp-headers-save-request.mjs";
import { saveMcpHeadersAuth } from "@/lib/mcp-headers-admin";
import { parseMcpAuthRemoveRequest, publicMcpAuthRemoveResult } from "@shared/mcp-auth-remove-request.mjs";
import { removeMcpAuth } from "@/lib/mcp-auth-remove-admin";
import { parseMcpOAuthStartRequest, publicMcpOAuthStartResult } from "@shared/mcp-oauth-start-request.mjs";
import { startMcpOAuthAuth } from "@/lib/mcp-oauth-start-admin";
import { parseMcpBearerSaveRequest, publicMcpBearerSaveResult } from "@shared/mcp-bearer-save-request.mjs";
import { saveMcpBearerAuth } from "@/lib/mcp-bearer-admin";
import { readMcpAuthStatus } from "@/lib/mcp-auth-status";
import { localRuntimeBlocked } from "@/lib/pi/runtime-ownership";
import {
  getMcpServerAuth,
  McpError,
  mcpErrorStatus,
  type McpAuthSnapshot,
} from "@/lib/mcp";
import {
  requestMcpWebUiAuth,
  type McpWebUiAuthRequest,
  type McpWebUiAuthResponse,
} from "@/lib/pi/mcp-webui-bridge";

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

function authAdapterError(operation: McpWebUiAuthRequest["operation"], error: unknown): McpError {
  // Do not reflect request values in an API error. In particular, a keyring or
  // OAuth implementation must not accidentally include the submitted secret.
  const message = operation === "oauth-complete"
    ? "OAuth認証の完了に失敗しました。認証の有効期限（開始から5分）が切れている場合は「OAuth認証を開始」からやり直してください"
    : operation === "oauth-start"
      ? "OAuth認証を開始できませんでした"
      : operation.startsWith("bearer")
        ? "Bearer認証情報を更新できませんでした"
        : operation.startsWith("headers")
          ? "HTTPヘッダー認証情報を更新できませんでした"
          : "MCP認証情報を更新できませんでした";
  void error;
  return new McpError("auth-unavailable", message);
}

async function callAdapter(request: McpWebUiAuthRequest): Promise<McpWebUiAuthResponse> {
  try {
    const response = await requestMcpWebUiAuth(request);
    if (!response) {
      throw new McpError("auth-unavailable", "MCPアダプターが起動していません。タスクを開いて再試行してください");
    }
    if (!response.ok) throw authAdapterError(request.operation, response.error);
    return response;
  } catch (error) {
    if (error instanceof McpError) throw error;
    throw authAdapterError(request.operation, error);
  }
}

function withAdapterStatus(
  snapshot: McpAuthSnapshot,
  response: McpWebUiAuthResponse | null,
): McpAuthSnapshot {
  if (!response || !response.ok) return snapshot;
  if (response.operation === "bearer-status") {
    return {
      ...snapshot,
      credentialStatus: response.status,
      ...(response.message ? { credentialMessage: response.message } : {}),
    };
  }
  if (response.operation === "headers-status") {
    return {
      ...snapshot,
      credentialStatus: response.status,
      ...(response.message ? { credentialMessage: response.message } : {}),
    };
  }
  if (response.operation === "oauth-status") {
    return {
      ...snapshot,
      credentialStatus: response.status === "authenticated"
        ? "present"
        : response.status === "expired"
          ? "expired"
          : response.status === "not_authenticated"
            ? "missing"
            : "unavailable",
      ...(response.message ? { credentialMessage: response.message } : {}),
    };
  }
  return snapshot;
}

async function snapshotWithLiveStatus(name: string): Promise<McpAuthSnapshot> {
  const snapshot = getMcpServerAuth(name);
  const operation: McpWebUiAuthRequest["operation"] | null = snapshot.authType === "bearer"
    ? snapshot.credentialSource === "secure-store" ? "bearer-status" : null
    : snapshot.authType === "headers"
      ? snapshot.credentialSource === "secure-store" ? "headers-status" : null
      : snapshot.authType === "oauth" || snapshot.authType === "auto"
        ? "oauth-status"
        : null;

  if (!operation) return snapshot;

  try {
    const response = await requestMcpWebUiAuth({ operation, serverName: name });
    return withAdapterStatus(snapshot, response);
  } catch (error) {
    return {
      ...snapshot,
      credentialStatus: "unavailable",
      credentialMessage: error instanceof Error ? error.message : "認証状態を確認できませんでした",
    };
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

function requireText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") throw new McpError("invalid-auth", `${label}が必要です`);
  const text = value.trim();
  if (!text || text.length > maxLength || /[\r\n]/.test(text)) {
    throw new McpError("invalid-auth", `${label}が不正です`);
  }
  return text;
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
      const input = requireText(body.input, "OAuthコールバックURLまたは認証コード", 16384);
      const response = await callAdapter({ operation: "oauth-complete", serverName: name, input });
      if (response.ok !== true || response.operation !== "oauth-complete") {
        throw new McpError("auth-unavailable", "OAuth認証の完了に失敗しました");
      }
      const reload = await reloadLiveSessionsContext();
      return NextResponse.json({
        ok: true,
        status: response.status,
        auth: await snapshotWithLiveStatus(name),
        reload,
      });
    }
    throw new McpError("invalid-auth", "OAuth操作が不正です");
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "MCP認証情報の保存に失敗しました" },
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
