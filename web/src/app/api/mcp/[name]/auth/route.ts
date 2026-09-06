/**
 * GET/POST/DELETE /api/mcp/:name/auth — inspect and manage MCP credentials.
 *
 * Secret material is accepted only for bearer/header save operations and is
 * forwarded to the MCP adapter's OS credential-store bridge. It is never
 * included in a response or written to mcp.json.
 */
import { NextRequest, NextResponse } from "next/server";
import { reloadLiveSessionsContext } from "@/lib/pi/harness";
import {
  disableMcpBearerStore,
  disableMcpHeadersStore,
  enableMcpBearerStore,
  enableMcpHeadersStore,
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
    ? "OAuth認証の完了に失敗しました"
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

function requireHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new McpError("invalid-auth", "HTTPヘッダーが必要です");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 32) {
    throw new McpError("invalid-auth", "HTTPヘッダーは1〜32個で指定してください");
  }
  const headers: Record<string, string> = {};
  for (const [rawName, rawValue] of entries) {
    const name = requireText(rawName, "HTTPヘッダー名", 256);
    const valueText = requireText(rawValue, `HTTPヘッダー ${name} の値`, 8192);
    Object.defineProperty(headers, name, {
      configurable: true,
      enumerable: true,
      value: valueText,
      writable: true,
    });
  }
  try {
    new Headers(headers);
  } catch {
    throw new McpError("invalid-auth", "HTTPヘッダー名または値が不正です");
  }
  return headers;
}

export async function GET(_req: NextRequest, context: RouteContext) {
  try {
    const { name: rawName } = await context.params;
    const name = readName(rawName);
    return NextResponse.json(await snapshotWithLiveStatus(name));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "MCP認証状態の取得に失敗しました" },
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
      const token = requireText(body.token, "Bearerトークン", 8192);
      const current = getMcpServerAuth(name);
      await callAdapter({ operation: "bearer-save", serverName: name, token });
      if (current.authType === "headers" && current.credentialSource === "secure-store") {
        await callAdapter({ operation: "headers-remove", serverName: name });
      }
      // This only enables the adapter's store flag. The token itself never
      // reaches this config writer.
      enableMcpBearerStore(name);
      const reload = await reloadLiveSessionsContext();
      return NextResponse.json({
        ok: true,
        auth: await snapshotWithLiveStatus(name),
        reload,
      });
    }

    if (method === "headers") {
      const headers = requireHeaders(body.headers);
      const current = getMcpServerAuth(name);
      await callAdapter({ operation: "headers-save", serverName: name, headers });
      if (current.authType === "bearer" && current.credentialSource === "secure-store") {
        await callAdapter({ operation: "bearer-remove", serverName: name });
      }
      // Header values stay in the adapter's OS credential store. Only this
      // non-secret selector is persisted in mcp.json.
      enableMcpHeadersStore(name);
      const reload = await reloadLiveSessionsContext();
      return NextResponse.json({
        ok: true,
        auth: await snapshotWithLiveStatus(name),
        reload,
      });
    }

    const action = body.action ?? "start";
    if (action === "start") {
      const response = await callAdapter({ operation: "oauth-start", serverName: name });
      if (response.ok !== true || response.operation !== "oauth-start") {
        throw new McpError("auth-unavailable", "OAuth認証を開始できませんでした");
      }
      return NextResponse.json({
        ok: true,
        authorizationUrl: response.authorizationUrl,
        status: response.status,
      });
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
    const name = readName(rawName);
    let body: AuthBody = {};
    try {
      body = bodyObject(await req.json());
    } catch {
      // An empty DELETE body defaults to the configured authentication method.
    }
    const snapshot = getMcpServerAuth(name);
    const method = methodFromBody(
      body,
      snapshot.authType === "oauth" || snapshot.authType === "auto"
        ? "oauth"
        : snapshot.authType === "headers"
          ? "headers"
          : "bearer",
    );

    if (method === "bearer") {
      await callAdapter({ operation: "bearer-remove", serverName: name });
      disableMcpBearerStore(name);
      const reload = await reloadLiveSessionsContext();
      return NextResponse.json({ ok: true, auth: await snapshotWithLiveStatus(name), reload });
    }

    if (method === "headers") {
      await callAdapter({ operation: "headers-remove", serverName: name });
      disableMcpHeadersStore(name);
      const reload = await reloadLiveSessionsContext();
      return NextResponse.json({ ok: true, auth: await snapshotWithLiveStatus(name), reload });
    }

    await callAdapter({ operation: "oauth-remove", serverName: name });
    const reload = await reloadLiveSessionsContext();
    return NextResponse.json({ ok: true, auth: await snapshotWithLiveStatus(name), reload });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "MCP認証情報の削除に失敗しました" },
      { status: mcpErrorStatus(error) },
    );
  }
}
