"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Switch } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";

type McpAuthType = "none" | "bearer" | "oauth" | "headers" | "auto";
type McpCredentialSource = "none" | "config" | "environment" | "secure-store" | "oauth" | "headers";
type McpCredentialStatus =
  | "present"
  | "missing"
  | "expired"
  | "unknown"
  | "unavailable"
  | "url-mismatch";

type McpDto = {
  id: string;
  name: string;
  enabled: boolean;
  source: "stdio" | "http";
  url?: string;
  authType: McpAuthType;
  credentialConfigured: boolean;
  credentialSource: McpCredentialSource;
  credentialStatus: McpCredentialStatus;
};

type McpResponse = {
  servers: McpDto[];
  configPath: string;
};

type McpAuthSnapshot = {
  name: string;
  configPath: string;
  url?: string;
  authType: McpAuthType;
  credentialConfigured: boolean;
  credentialSource: McpCredentialSource;
  credentialStatus: McpCredentialStatus;
  credentialMessage?: string;
};

type OAuthStartResponse = {
  ok: true;
  authorizationUrl: string;
  status: "authenticated" | "pending";
};

type AuthMutationResponse = {
  ok: true;
  auth?: McpAuthSnapshot;
};

const MCP_SERVER_DESCRIPTIONS: Readonly<Record<string, string>> = {
  fxhoudini: "リモート Houdini のシーン構築、シミュレーション、レンダリングを操作します。",
  blendermcp: "Blender Lab 公式 MCP で、リモート Blender のシーン・オブジェクト・ドキュメント・レンダリングを操作します。",
  mayamcp: "PatrickPalmer/MayaMCP で、リモート Maya のシーン構築・モデリング・マテリアルを操作します。",
  metatrader: "MetaTrader 5 の口座・相場・注文・ポジションを確認・管理します。",
  "mt5-build": "MQL4/MQL5 のコンパイル、静的検査、デプロイ、Strategy Tester、レポート解析を行います。",
  "comfy-mcp": "ComfyUI で画像・動画・音声・3D生成、ワークフロー編集、ジョブ監視を行います。",
};

function authTypeLabel(type: McpAuthType): string {
  switch (type) {
    case "bearer": return "Bearer";
    case "oauth": return "OAuth";
    case "headers": return "HTTPヘッダー";
    case "auto": return "自動（OAuth）";
    default: return "認証なし";
  }
}

function authSourceLabel(source: McpCredentialSource): string {
  switch (source) {
    case "secure-store": return "OS資格情報ストア";
    case "environment": return "環境変数";
    case "config": return "設定ファイル";
    case "headers": return "設定ヘッダー";
    case "oauth": return "OAuth資格情報ストア";
    default: return "なし";
  }
}

function authStatusLabel(status: McpCredentialStatus): string {
  switch (status) {
    case "present": return "設定済み";
    case "expired": return "期限切れ";
    case "missing": return "未設定";
    case "url-mismatch": return "URL変更後の再認証が必要";
    case "unavailable": return "確認できません";
    default: return "未確認";
  }
}

function authStatusTone(status: McpCredentialStatus): "neutral" | "success" | "warning" | "danger" {
  if (status === "present") return "success";
  if (status === "expired" || status === "url-mismatch") return "warning";
  if (status === "unavailable") return "danger";
  return "neutral";
}

export function McpSettings() {
  const [servers, setServers] = useState<McpDto[]>([]);
  const [configPath, setConfigPath] = useState<string>("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [authBusyId, setAuthBusyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [authById, setAuthById] = useState<Record<string, McpAuthSnapshot>>({});
  const [tokenById, setTokenById] = useState<Record<string, string>>({});
  const [headerNameById, setHeaderNameById] = useState<Record<string, string>>({});
  const [headerValueById, setHeaderValueById] = useState<Record<string, string>>({});
  const [oauthInputById, setOauthInputById] = useState<Record<string, string>>({});
  const [oauthUrlById, setOauthUrlById] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    setLoading(true);
    void getJson<McpResponse>("/api/mcp")
      .then((result) => {
        setServers(result.servers);
        setConfigPath(result.configPath);
        setAuthById({});
        setError(null);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "MCP サーバー一覧の取得に失敗しました");
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function toggle(server: McpDto) {
    if (busyId || authBusyId) return;
    setBusyId(server.id);
    setError(null);
    try {
      const result = await sendJson<{ servers: McpDto[] }>(
        `/api/mcp/${encodeURIComponent(server.id)}`,
        { enabled: !server.enabled },
        "PATCH",
      );
      setServers(result.servers);
    } catch (err) {
      setError(err instanceof Error ? err.message : "MCP サーバーの切替に失敗しました");
      reload();
    } finally {
      setBusyId(null);
    }
  }

  async function openAuth(server: McpDto) {
    if (expandedId === server.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(server.id);
    if (authById[server.id]) return;
    setAuthBusyId(server.id);
    try {
      const result = await getJson<McpAuthSnapshot>(
        `/api/mcp/${encodeURIComponent(server.id)}/auth`,
      );
      setAuthById((current) => ({ ...current, [server.id]: result }));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "MCP認証状態の取得に失敗しました");
    } finally {
      setAuthBusyId(null);
    }
  }

  async function saveBearer(server: McpDto) {
    const token = tokenById[server.id]?.trim() ?? "";
    if (!token) {
      setError("Bearerトークンを入力してください");
      return;
    }
    setAuthBusyId(server.id);
    setError(null);
    try {
      const result = await sendJson<AuthMutationResponse>(
        `/api/mcp/${encodeURIComponent(server.id)}/auth`,
        { type: "bearer", token },
        "POST",
      );
      if (result.auth) setAuthById((current) => ({ ...current, [server.id]: result.auth! }));
      setTokenById((current) => ({ ...current, [server.id]: "" }));
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bearer認証情報の保存に失敗しました");
    } finally {
      setAuthBusyId(null);
    }
  }

  async function removeBearer(server: McpDto) {
    setAuthBusyId(server.id);
    setError(null);
    try {
      const result = await sendJson<AuthMutationResponse>(
        `/api/mcp/${encodeURIComponent(server.id)}/auth`,
        { type: "bearer" },
        "DELETE",
      );
      if (result.auth) setAuthById((current) => ({ ...current, [server.id]: result.auth! }));
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bearer認証情報の削除に失敗しました");
    } finally {
      setAuthBusyId(null);
    }
  }

  async function saveHeaders(server: McpDto) {
    const name = headerNameById[server.id]?.trim() ?? "";
    const value = headerValueById[server.id]?.trim() ?? "";
    if (!name || !value) {
      setError("HTTPヘッダー名と値を入力してください");
      return;
    }
    setAuthBusyId(server.id);
    setError(null);
    try {
      const result = await sendJson<AuthMutationResponse>(
        `/api/mcp/${encodeURIComponent(server.id)}/auth`,
        { type: "headers", headers: { [name]: value } },
        "POST",
      );
      if (result.auth) setAuthById((current) => ({ ...current, [server.id]: result.auth! }));
      setHeaderValueById((current) => ({ ...current, [server.id]: "" }));
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "HTTPヘッダー認証情報の保存に失敗しました");
    } finally {
      setAuthBusyId(null);
    }
  }

  async function removeHeaders(server: McpDto) {
    setAuthBusyId(server.id);
    setError(null);
    try {
      const result = await sendJson<AuthMutationResponse>(
        `/api/mcp/${encodeURIComponent(server.id)}/auth`,
        { type: "headers" },
        "DELETE",
      );
      if (result.auth) setAuthById((current) => ({ ...current, [server.id]: result.auth! }));
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "HTTPヘッダー認証情報の削除に失敗しました");
    } finally {
      setAuthBusyId(null);
    }
  }

  async function startOAuth(server: McpDto) {
    setAuthBusyId(server.id);
    setError(null);
    try {
      const result = await sendJson<OAuthStartResponse>(
        `/api/mcp/${encodeURIComponent(server.id)}/auth`,
        { type: "oauth", action: "start" },
        "POST",
      );
      setOauthUrlById((current) => ({
        ...current,
        [server.id]: result.authorizationUrl,
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "OAuth認証を開始できませんでした");
    } finally {
      setAuthBusyId(null);
    }
  }

  async function completeOAuth(server: McpDto) {
    const input = oauthInputById[server.id]?.trim() ?? "";
    if (!input) {
      setError("OAuthコールバックURLまたは認証コードを入力してください");
      return;
    }
    setAuthBusyId(server.id);
    setError(null);
    try {
      const result = await sendJson<AuthMutationResponse>(
        `/api/mcp/${encodeURIComponent(server.id)}/auth`,
        { type: "oauth", action: "complete", input },
        "POST",
      );
      if (result.auth) setAuthById((current) => ({ ...current, [server.id]: result.auth! }));
      setOauthInputById((current) => ({ ...current, [server.id]: "" }));
      setOauthUrlById((current) => ({ ...current, [server.id]: "" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "OAuth認証の完了に失敗しました");
    } finally {
      setAuthBusyId(null);
    }
  }

  async function removeOAuth(server: McpDto) {
    setAuthBusyId(server.id);
    setError(null);
    try {
      const result = await sendJson<AuthMutationResponse>(
        `/api/mcp/${encodeURIComponent(server.id)}/auth`,
        { type: "oauth" },
        "DELETE",
      );
      if (result.auth) setAuthById((current) => ({ ...current, [server.id]: result.auth! }));
      setOauthUrlById((current) => ({ ...current, [server.id]: "" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "OAuth認証情報の削除に失敗しました");
    } finally {
      setAuthBusyId(null);
    }
  }

  function renderAuthPanel(server: McpDto) {
    const auth = authById[server.id];
    const status = auth?.credentialStatus ?? server.credentialStatus;
    const source = auth?.credentialSource ?? server.credentialSource;
    const supportsOAuth = server.authType === "oauth" || server.authType === "auto";
    const oauthUrl = oauthUrlById[server.id];
    const authBusy = authBusyId === server.id;

    return (
      <div className="mt-3 border-t border-border pt-3" data-testid={`mcp-auth-${server.id}`}>
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs font-semibold text-text">認証設定</p>
          <Badge tone="neutral">{authTypeLabel(auth?.authType ?? server.authType)}</Badge>
          <Badge tone={authStatusTone(status)}>{authStatusLabel(status)}</Badge>
          <span className="text-[11px] text-muted">保存先: {authSourceLabel(source)}</span>
        </div>
        {auth?.credentialMessage && (
          <p className="mt-1 text-xs text-muted">{auth.credentialMessage}</p>
        )}

        <div className={`mt-3 grid gap-3 ${supportsOAuth ? "xl:grid-cols-3" : "lg:grid-cols-2"}`}>
          <div className="rounded-lg border border-border bg-surface px-3 py-3" data-testid={`mcp-bearer-${server.id}`}>
            <p className="text-xs font-medium text-text">Bearerトークン</p>
            <p className="mt-1 text-[11px] leading-4 text-muted">
              トークンは表示・設定ファイル保存をせず、OS資格情報ストアに保存します。
            </p>
            <label className="mt-2 block">
              <span className="sr-only">{server.name} のBearerトークン</span>
              <input
                type="password"
                autoComplete="new-password"
                value={tokenById[server.id] ?? ""}
                onChange={(event) => setTokenById((current) => ({ ...current, [server.id]: event.target.value }))}
                placeholder="新しいトークンを入力"
                className="h-9 w-full rounded-lg border border-border bg-bg px-3 text-xs text-text outline-none focus:border-border-strong"
                disabled={authBusy}
              />
            </label>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="primary" onClick={() => void saveBearer(server)} busy={authBusy}>
                保存
              </Button>
              <Button size="sm" variant="danger" onClick={() => void removeBearer(server)} disabled={source !== "secure-store" || status === "missing"} busy={authBusy}>
                削除
              </Button>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-surface px-3 py-3" data-testid={`mcp-headers-${server.id}`}>
            <p className="text-xs font-medium text-text">HTTPヘッダー</p>
            <p className="mt-1 text-[11px] leading-4 text-muted">
              APIキーなどのカスタムヘッダーをOS資格情報ストアへ保存します。既存の値は表示しません。
            </p>
            <label className="mt-2 block">
              <span className="sr-only">{server.name} のHTTPヘッダー名</span>
              <input
                type="text"
                autoComplete="off"
                value={headerNameById[server.id] ?? ""}
                onChange={(event) => setHeaderNameById((current) => ({ ...current, [server.id]: event.target.value }))}
                placeholder="ヘッダー名（例: X-API-Key）"
                className="h-9 w-full rounded-lg border border-border bg-bg px-3 text-xs text-text outline-none focus:border-border-strong"
                disabled={authBusy}
              />
            </label>
            <label className="mt-2 block">
              <span className="sr-only">{server.name} のHTTPヘッダー値</span>
              <input
                type="password"
                autoComplete="new-password"
                value={headerValueById[server.id] ?? ""}
                onChange={(event) => setHeaderValueById((current) => ({ ...current, [server.id]: event.target.value }))}
                placeholder="ヘッダー値を入力"
                className="h-9 w-full rounded-lg border border-border bg-bg px-3 text-xs text-text outline-none focus:border-border-strong"
                disabled={authBusy}
              />
            </label>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="primary" onClick={() => void saveHeaders(server)} busy={authBusy}>
                保存
              </Button>
              <Button size="sm" variant="danger" onClick={() => void removeHeaders(server)} disabled={source !== "secure-store"} busy={authBusy}>
                削除
              </Button>
            </div>
          </div>

          {supportsOAuth ? (
            <div className="rounded-lg border border-border bg-surface px-3 py-3">
              <p className="text-xs font-medium text-text">OAuth</p>
              <p className="mt-1 text-[11px] leading-4 text-muted">
                ブラウザで認証し、コールバックURLまたは認証コードをここへ貼り付けます。
              </p>
              <Button size="sm" className="mt-2" onClick={() => void startOAuth(server)} busy={authBusy}>
                OAuth認証を開始
              </Button>
              {oauthUrl && (
                <div className="mt-2 rounded-lg bg-surface-2 p-2 text-xs">
                  <a
                    href={oauthUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary underline underline-offset-2"
                  >
                    認証ページをブラウザで開く
                  </a>
                  <p className="mt-1 break-all font-mono text-[10px] text-muted">{oauthUrl}</p>
                  <label className="mt-2 block">
                    <span className="sr-only">{server.name} のOAuthコールバックURLまたは認証コード</span>
                    <input
                      type="text"
                      autoComplete="off"
                      value={oauthInputById[server.id] ?? ""}
                      onChange={(event) => setOauthInputById((current) => ({ ...current, [server.id]: event.target.value }))}
                      placeholder="コールバックURLまたはコード"
                      className="h-9 w-full rounded-lg border border-border bg-bg px-3 font-mono text-xs text-text outline-none focus:border-border-strong"
                      disabled={authBusy}
                    />
                  </label>
                  <Button size="sm" variant="primary" className="mt-2" onClick={() => void completeOAuth(server)} busy={authBusy}>
                    認証を完了
                  </Button>
                </div>
              )}
              <div className="mt-2">
                <Button size="sm" variant="danger" onClick={() => void removeOAuth(server)} disabled={status === "missing"} busy={authBusy}>
                  OAuth認証を解除
                </Button>
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-border bg-surface px-3 py-3 text-[11px] leading-4 text-muted">
              OAuthはこのサーバーで無効です。BearerまたはカスタムHTTPヘッダーを保存できます。
            </div>
          )}
        </div>
      </div>
    );
  }

  const anyBusy = Boolean(busyId || authBusyId);

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">MCP サーバー</h3>
        <Button variant="secondary" size="sm" onClick={() => reload()} disabled={loading || anyBusy}>
          再読込
        </Button>
      </div>
      <p className="text-xs text-muted">
        leafcode-mcp-adapter が読む MCP サーバー設定（
        <span className="font-mono">~/.pi/agent/mcp.json</span>
        ）の有効／無効と認証情報を管理します。秘密情報は表示せず、OS資格情報ストアへ保存します。
      </p>
      {configPath && (
        <div className="mt-1 space-y-0.5 font-mono text-[11px] text-muted">
          <p className="break-all">{configPath}</p>
        </div>
      )}
      {loading && servers.length === 0 ? (
        <p className="mt-3 text-sm text-muted">読み込み中…</p>
      ) : servers.length === 0 ? (
        <p className="mt-3 text-sm text-muted">
          MCP サーバーがありません。{" "}
          <span className="font-mono">.mcp.json</span> に mcpServers を追加してください。
        </p>
      ) : (
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {servers.map((server) => (
            <li
              key={server.id}
              aria-busy={busyId === server.id || authBusyId === server.id || undefined}
              className="rounded-xl border border-border bg-surface-2 px-3 py-2.5"
            >
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="min-w-0 truncate text-sm font-medium text-text" title={server.id}>
                      {server.name}
                    </p>
                    <Badge tone={server.source === "http" ? "warning" : "neutral"}>
                      {server.source}
                    </Badge>
                    <Badge tone={server.enabled ? "success" : "neutral"}>
                      {server.enabled ? "有効" : "無効"}
                    </Badge>
                    {server.source === "http" && (
                      <Badge tone={authStatusTone(server.credentialStatus)}>
                        {authTypeLabel(server.authType)}: {authStatusLabel(server.credentialStatus)}
                      </Badge>
                    )}
                  </div>
                  {server.url && <p className="mt-1 break-all font-mono text-[10px] text-muted">{server.url}</p>}
                  {MCP_SERVER_DESCRIPTIONS[server.id] && (
                    <p className="mt-0.5 break-words text-xs text-muted">{MCP_SERVER_DESCRIPTIONS[server.id]}</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {server.source === "http" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void openAuth(server)}
                      busy={authBusyId === server.id && !authById[server.id]}
                      aria-expanded={expandedId === server.id}
                    >
                      {expandedId === server.id ? "閉じる" : "認証設定"}
                    </Button>
                  )}
                  <Switch
                    checked={server.enabled}
                    onChange={() => void toggle(server)}
                    label={`${server.name} を${server.enabled ? "無効化" : "有効化"}`}
                    busy={busyId === server.id || Boolean(authBusyId)}
                  />
                </div>
              </div>
              {expandedId === server.id && server.source === "http" && renderAuthPanel(server)}
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-2 text-sm text-danger" role="alert">{error}</p>}
    </div>
  );
}
