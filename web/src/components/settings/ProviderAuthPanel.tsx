"use client";

import { useEffect, useState } from "react";
import { Badge, Button, cx } from "@/components/ui";
import { ProviderIcon } from "@/components/ProviderIcon";
import { ApiError, apiUrl, getJson, sendJson } from "@/lib/client";
import type { AccountRecord } from "@/lib/accounts";
import type { LoginNotifyDto, LoginPromptDto, LoginSessionEvent } from "@/lib/pi/auth-login";
import type { ProviderAuthDto } from "@/lib/types";

type LoginUiState = {
  providerId: string;
  providerName: string;
  authType: "api_key" | "oauth";
  accountId: string | null;
  sessionId: string | null;
  status: string;
  prompt: { id: string; prompt: LoginPromptDto } | null;
  authUrl: string | null;
  deviceCode: (LoginNotifyDto & { type: "device_code" }) | null;
  input: string;
  busy: boolean;
  error: string | null;
  warning: string | null;
};

function authBadge(provider: ProviderAuthDto) {
  if (provider.subscription) return { tone: "success" as const, label: "サブスク認証済" };
  if (provider.authenticated) return { tone: "success" as const, label: "認証済" };
  return { tone: "neutral" as const, label: "未設定" };
}

function sourceHint(provider: ProviderAuthDto): string | null {
  if (!provider.authenticated) return null;
  if (provider.subscription) {
    if (provider.id === "cursor") return "Cursor サブスク";
    if (provider.id === "openai-codex") return "ChatGPT Plus/Pro サブスク";
    if (provider.id === "anthropic") return "Claude Pro/Max サブスク";
    return "サブスクリプション";
  }
  if (provider.authSource === "environment") {
    return provider.authLabel ? `環境変数 ${provider.authLabel}` : "環境変数";
  }
  if (provider.authSource === "stored") return "~/.pi/agent/auth.json";
  if (provider.authSource === "runtime") return "実行時キー";
  return provider.authSource ?? null;
}

export function ProviderAuthPanel({
  providers,
  onChanged,
}: {
  providers: ProviderAuthDto[];
  onChanged: () => void;
}) {
  const [login, setLogin] = useState<LoginUiState | null>(null);
  // アカウント（docs/plans/multi-account.md）。null = 未取得、[] = 取得済みで空。
  const [accounts, setAccounts] = useState<AccountRecord[] | null>(null);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [creatingAccount, setCreatingAccount] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newNote, setNewNote] = useState("");
  const [newProviders, setNewProviders] = useState({ codex: false, anthropic: false });
  const [accountBusy, setAccountBusy] = useState(false);
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");

  async function refreshAccounts() {
    try {
      const res = await getJson<{ accounts: AccountRecord[] }>("/api/accounts");
      setAccounts(res.accounts);
      setAccountsError(null);
    } catch (error) {
      setAccountsError(error instanceof ApiError ? error.message : String(error));
    }
  }

  useEffect(() => {
    void refreshAccounts();
  }, []);

  useEffect(() => {
    if (!login?.sessionId) return;
    const providerId = login.providerId;
    const es = new EventSource(apiUrl(`/api/providers/${encodeURIComponent(providerId)}/login/events`));
    es.addEventListener("notify", (raw) => {
      const payload = JSON.parse((raw as MessageEvent).data) as Extract<LoginSessionEvent, { type: "notify" }>;
      const event = payload.event;
      if (event.type === "auth_url") {
        setLogin((prev) =>
          prev
            ? {
                ...prev,
                authUrl: event.url,
                status: event.instructions ?? "ブラウザでログインしてください",
              }
            : prev,
        );
        window.open(event.url, "_blank", "noopener,noreferrer");
      } else if (event.type === "device_code") {
        setLogin((prev) =>
          prev
            ? {
                ...prev,
                deviceCode: event,
                status: "デバイスコードでログインしてください",
              }
            : prev,
        );
        window.open(event.verificationUri, "_blank", "noopener,noreferrer");
      } else if (event.type === "progress" || event.type === "info") {
        setLogin((prev) => (prev ? { ...prev, status: event.message } : prev));
      }
    });
    es.addEventListener("prompt", (raw) => {
      const payload = JSON.parse((raw as MessageEvent).data) as Extract<LoginSessionEvent, { type: "prompt" }>;
      setLogin((prev) =>
        prev
          ? {
              ...prev,
              prompt: { id: payload.id, prompt: payload.prompt },
              input: "",
              busy: false,
              status: payload.prompt.message,
            }
          : prev,
      );
    });
    es.addEventListener("done", (raw) => {
      const payload = JSON.parse((raw as MessageEvent).data) as Extract<LoginSessionEvent, { type: "done" }>;
      es.close();
      if (payload.ok) {
        setLogin((prev) =>
          prev
            ? {
                ...prev,
                busy: false,
                prompt: null,
                status: "ログイン完了",
                warning: "warning" in payload ? payload.warning ?? null : null,
                error: null,
              }
            : prev,
        );
        onChanged();
        window.setTimeout(() => setLogin(null), 1500);
      } else {
        setLogin((prev) =>
          prev
            ? {
                ...prev,
                busy: false,
                error: payload.error,
                status: "失敗",
              }
            : prev,
        );
      }
    });
    return () => es.close();
  }, [login?.sessionId, login?.providerId, onChanged]);

  async function stopLogin() {
    if (login) {
      try {
        await fetch(apiUrl(`/api/providers/${encodeURIComponent(login.providerId)}/login/answer`), {
          method: "DELETE",
        });
      } catch {
        /* ignore */
      }
    }
    setLogin(null);
  }

  async function beginLogin(
    provider: Pick<ProviderAuthDto, "id" | "name">,
    authType: "api_key" | "oauth",
    accountId?: string | null,
  ) {
    setLogin({
      providerId: provider.id,
      providerName: provider.name,
      authType,
      accountId: accountId ?? null,
      sessionId: null,
      status: "開始中…",
      prompt: null,
      authUrl: null,
      deviceCode: null,
      input: "",
      busy: true,
      error: null,
      warning: null,
    });
    try {
      const result = await sendJson<{ sessionId: string }>(
        apiUrl(`/api/providers/${encodeURIComponent(provider.id)}/login`, {
          accountId: accountId ?? undefined,
        }),
        { type: authType },
      );
      setLogin((prev) =>
        prev
          ? {
              ...prev,
              sessionId: result.sessionId,
              busy: false,
              status: "認証フロー待機中…",
            }
          : prev,
      );
    } catch (error) {
      setLogin((prev) =>
        prev
          ? {
              ...prev,
              busy: false,
              error: error instanceof ApiError ? error.message : String(error),
            }
          : prev,
      );
    }
  }

  async function submitAnswer(value: string) {
    if (!login?.prompt) return;
    setLogin((prev) => (prev ? { ...prev, busy: true, error: null } : prev));
    try {
      await sendJson(`/api/providers/${encodeURIComponent(login.providerId)}/login/answer`, {
        promptId: login.prompt.id,
        value,
      });
      setLogin((prev) => (prev ? { ...prev, prompt: null, input: "", busy: false, status: "続行中…" } : prev));
    } catch (error) {
      setLogin((prev) =>
        prev
          ? {
              ...prev,
              busy: false,
              error: error instanceof ApiError ? error.message : String(error),
            }
          : prev,
      );
    }
  }

  async function logout(provider: ProviderAuthDto) {
    try {
      await sendJson(`/api/providers/${encodeURIComponent(provider.id)}/logout`, {});
      onChanged();
    } catch (error) {
      window.alert(error instanceof ApiError ? error.message : String(error));
    }
  }

  // --- アカウント管理（docs/plans/multi-account.md Phase 5）---

  function providerLabel(providerId: string): string {
    if (providerId === "openai-codex") return "ChatGPT (Codex)";
    if (providerId === "anthropic") return "Claude";
    return providerId;
  }

  async function submitCreateAccount() {
    const providers = [
      ...(newProviders.codex ? ["openai-codex"] : []),
      ...(newProviders.anthropic ? ["anthropic"] : []),
    ];
    if (!newLabel.trim() || providers.length === 0) return;
    setAccountBusy(true);
    try {
      await sendJson("/api/accounts", {
        label: newLabel.trim(),
        providers,
        note: newNote.trim() || undefined,
      });
      setCreatingAccount(false);
      setNewLabel("");
      setNewNote("");
      setNewProviders({ codex: false, anthropic: false });
      await refreshAccounts();
    } catch (error) {
      window.alert(error instanceof ApiError ? error.message : String(error));
    } finally {
      setAccountBusy(false);
    }
  }

  async function saveAccountLabel(id: string) {
    if (!editLabel.trim()) return;
    setAccountBusy(true);
    try {
      await sendJson(`/api/accounts/${encodeURIComponent(id)}`, { label: editLabel.trim() }, "PATCH");
      setEditingAccountId(null);
      await refreshAccounts();
    } catch (error) {
      window.alert(error instanceof ApiError ? error.message : String(error));
    } finally {
      setAccountBusy(false);
    }
  }

  async function removeAccount(account: AccountRecord) {
    if (!window.confirm(`アカウント「${account.label}」を削除しますか？`)) return;
    setAccountBusy(true);
    try {
      await sendJson(`/api/accounts/${encodeURIComponent(account.id)}`, {}, "DELETE");
      if (login?.accountId === account.id) stopLogin();
      await refreshAccounts();
      onChanged();
    } catch (error) {
      window.alert(error instanceof ApiError ? error.message : String(error));
    } finally {
      setAccountBusy(false);
    }
  }

  async function logoutFor(providerId: string, accountId?: string | null) {
    try {
      await sendJson(
        apiUrl(`/api/providers/${encodeURIComponent(providerId)}/logout`, {
          accountId: accountId ?? undefined,
        }),
        {},
      );
      onChanged();
    } catch (error) {
      window.alert(error instanceof ApiError ? error.message : String(error));
    }
  }

  const highlighted = providers.filter((p) => p.highlighted);
  const others = providers.filter((p) => !p.highlighted);

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">アカウント</h2>
          {!creatingAccount && (
            <Button size="sm" variant="ghost" onClick={() => setCreatingAccount(true)}>
              追加
            </Button>
          )}
        </div>
        <p className="mb-3 text-xs text-muted">
          サブスクアカウントを複数登録してタスクごとに切り替えます。未登録のタスクは既定（~/.pi/agent/auth.json）を使います。
          OAuth のログインは同時に 1 件のみです。
        </p>
        {accountsError && <p className="mb-2 text-xs text-danger">{accountsError}</p>}
        {accounts === null ? (
          <p className="text-xs text-muted">読み込み中…</p>
        ) : (
          <ul className="space-y-2">
            {accounts.length === 0 && !creatingAccount && (
              <li className="text-sm text-muted">追加アカウントはまだありません</li>
            )}
            {accounts.map((account) => (
              <li key={account.id} className="rounded-xl border border-border bg-surface px-2 py-2">
                {editingAccountId === account.id ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      className="min-w-0 flex-1 rounded-xl border border-border bg-surface px-3 py-1.5 text-sm outline-none focus:border-accent"
                      value={editLabel}
                      onChange={(event) => setEditLabel(event.target.value)}
                      aria-label="アカウント名"
                      autoFocus
                    />
                    <Button
                      size="sm"
                      disabled={accountBusy || !editLabel.trim()}
                      onClick={() => void saveAccountLabel(account.id)}
                    >
                      保存
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditingAccountId(null)}>
                      キャンセル
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{account.label}</span>
                    {account.note && <span className="text-xs text-muted">{account.note}</span>}
                    {account.providers.map((pid) => (
                      <Badge key={pid}>{providerLabel(pid)}</Badge>
                    ))}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditingAccountId(account.id);
                        setEditLabel(account.label);
                      }}
                    >
                      編集
                    </Button>
                  </div>
                )}
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {account.providers.map((pid) => (
                    <Button
                      key={`in-${pid}`}
                      size="sm"
                      disabled={Boolean(login) || accountBusy}
                      onClick={() =>
                        void beginLogin(
                          providers.find((p) => p.id === pid) ?? { id: pid, name: providerLabel(pid) },
                          "oauth",
                          account.id,
                        )
                      }
                    >
                      {providerLabel(pid)} でログイン
                    </Button>
                  ))}
                  {account.providers.map((pid) => (
                    <Button
                      key={`out-${pid}`}
                      size="sm"
                      variant="ghost"
                      disabled={Boolean(login) || accountBusy}
                      onClick={() => void logoutFor(pid, account.id)}
                    >
                      {providerLabel(pid)} ログアウト
                    </Button>
                  ))}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={accountBusy}
                    onClick={() => void removeAccount(account)}
                  >
                    削除
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {creatingAccount && (
          <div className="mt-2 rounded-2xl border border-border bg-surface-2 p-4">
            <h3 className="mb-2 text-sm font-semibold">アカウントを作成</h3>
            <label htmlFor="new-account-label" className="text-xs text-muted">
              表示名
            </label>
            <input
              id="new-account-label"
              value={newLabel}
              onChange={(event) => setNewLabel(event.target.value)}
              placeholder="例: 仕事用 ChatGPT"
              className="mb-3 mt-1 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
            />
            <fieldset className="mb-3">
              <legend className="text-xs text-muted">使うプロバイダー（後から変更できません）</legend>
              <label className="mr-4 inline-flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={newProviders.codex}
                  onChange={(event) =>
                    setNewProviders((prev) => ({ ...prev, codex: event.target.checked }))
                  }
                />
                ChatGPT (Codex)
              </label>
              <label className="inline-flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={newProviders.anthropic}
                  onChange={(event) =>
                    setNewProviders((prev) => ({ ...prev, anthropic: event.target.checked }))
                  }
                />
                Claude
              </label>
            </fieldset>
            <label htmlFor="new-account-note" className="text-xs text-muted">
              メモ（任意）
            </label>
            <input
              id="new-account-note"
              value={newNote}
              onChange={(event) => setNewNote(event.target.value)}
              className="mb-3 mt-1 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                busy={accountBusy}
                disabled={!newLabel.trim() || (!newProviders.codex && !newProviders.anthropic)}
                onClick={() => void submitCreateAccount()}
              >
                作成
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setCreatingAccount(false)}>
                キャンセル
              </Button>
            </div>
          </div>
        )}
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold">プロバイダ</h2>
        <p className="mb-3 text-xs text-muted">
          Claude Pro/Max（Anthropic）、ChatGPT Plus/Pro（OpenAI Codex）、Cursor、Command Code（Go プラン可）、および
          Ollama Cloud に対応しています。Command Code は{" "}
          <span className="font-mono">COMMANDCODE_API_KEY</span> /{" "}
          <span className="font-mono">~/.commandcode/auth.json</span>、Ollama Cloud は{" "}
          <span className="font-mono">OLLAMA_API_KEY</span> でも設定できます。
        </p>
        <ul className="space-y-2">
          {highlighted.length === 0 && (
            <li className="text-sm text-muted">サブスク対応プロバイダーが見つかりません</li>
          )}
          {highlighted.map((provider) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              disabled={Boolean(login)}
              onOAuth={provider.oauthAvailable ? () => void beginLogin(provider, "oauth") : undefined}
              onApiKey={
                provider.methods?.includes("api_key") ? () => void beginLogin(provider, "api_key") : undefined
              }
              onLogout={() => void logout(provider)}
            />
          ))}
        </ul>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold">その他のプロバイダー</h2>
        <p className="mb-3 text-xs text-muted">
          環境変数（ANTHROPIC_API_KEY / OPENCODE_API_KEY など）または ~/.pi/agent/auth.json も引き続き使えます。
        </p>
        <ul className="max-h-72 space-y-1 overflow-y-auto">
          {others.map((provider) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              compact
              disabled={Boolean(login)}
              onOAuth={provider.oauthAvailable ? () => void beginLogin(provider, "oauth") : undefined}
              onApiKey={
                provider.methods?.includes("api_key") ? () => void beginLogin(provider, "api_key") : undefined
              }
              onLogout={provider.authenticated ? () => void logout(provider) : undefined}
            />
          ))}
        </ul>
      </div>

      {login && (
        <div className="rounded-2xl border border-border bg-surface-2 p-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">
              {login.providerName} — {login.authType === "oauth" ? "サブスクログイン" : "API キー"}
              {login.accountId && (
                <span className="ml-1 text-xs font-normal text-muted">
                  （アカウント: {accounts?.find((a) => a.id === login.accountId)?.label ?? login.accountId}）
                </span>
              )}
            </h3>
            <Button variant="ghost" onClick={() => void stopLogin()}>
              キャンセル
            </Button>
          </div>
          <p className="text-sm text-muted">{login.status}</p>
          {login.authUrl && (
            <p className="mt-2 break-all text-xs">
              ブラウザが開かない場合:{" "}
              <a className="text-accent underline" href={login.authUrl} target="_blank" rel="noreferrer">
                {login.authUrl}
              </a>
            </p>
          )}
          {login.deviceCode && (
            <div className="mt-3 rounded-xl border border-border bg-surface p-3 text-sm">
              <p>
                コード: <span className="font-mono text-base font-semibold">{login.deviceCode.userCode}</span>
              </p>
              <a
                className="mt-1 inline-block text-accent underline"
                href={login.deviceCode.verificationUri}
                target="_blank"
                rel="noreferrer"
              >
                {login.deviceCode.verificationUri}
              </a>
            </div>
          )}
          {login.prompt?.prompt.type === "select" && (
            <div className="mt-3 flex flex-col gap-2">
              {login.prompt.prompt.options.map((option) => (
                <Button
                  key={option.id}
                  disabled={login.busy}
                  onClick={() => void submitAnswer(option.id)}
                  className="justify-start"
                >
                  <span>
                    {option.label}
                    {option.description ? (
                      <span className="ml-2 text-xs text-muted">{option.description}</span>
                    ) : null}
                  </span>
                </Button>
              ))}
            </div>
          )}
          {login.prompt && login.prompt.prompt.type !== "select" && (
            <form
              className="mt-3 flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void submitAnswer(login.input);
              }}
            >
              <label className="text-xs text-muted">{login.prompt.prompt.message}</label>
              <input
                className="rounded-xl border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
                type={login.prompt.prompt.type === "secret" ? "password" : "text"}
                value={login.input}
                placeholder={login.prompt.prompt.placeholder}
                disabled={login.busy}
                onChange={(event) => setLogin((prev) => (prev ? { ...prev, input: event.target.value } : prev))}
                autoFocus
              />
              <Button type="submit" disabled={login.busy || !login.input.trim()}>
                送信
              </Button>
            </form>
          )}
          {login.warning && <p className="mt-2 text-sm text-warning">{login.warning}</p>}
          {login.error && <p className="mt-2 text-sm text-danger">{login.error}</p>}
        </div>
      )}
    </div>
  );
}

function ProviderRow({
  provider,
  compact,
  disabled,
  onOAuth,
  onApiKey,
  onLogout,
}: {
  provider: ProviderAuthDto;
  compact?: boolean;
  disabled?: boolean;
  onOAuth?: () => void;
  onApiKey?: () => void;
  onLogout?: () => void;
}) {
  const badge = authBadge(provider);
  const hint = sourceHint(provider);
  return (
    <li
      className={cx(
        "flex flex-col gap-2 rounded-xl px-2 py-2 sm:flex-row sm:items-center sm:justify-between",
        compact ? "" : "border border-border bg-surface",
      )}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <ProviderIcon providerID={provider.id} size={16} />
          <span className="text-sm font-medium">{provider.name}</span>
          <span className="font-mono text-xs text-muted">{provider.id}</span>
          <Badge tone={badge.tone}>{badge.label}</Badge>
        </div>
        {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
      </div>
      <div className="flex flex-wrap gap-1">
        {onOAuth && (
          <Button size="sm" disabled={disabled} onClick={onOAuth}>
            ログイン
          </Button>
        )}
        {onApiKey && (
          <Button size="sm" variant="ghost" disabled={disabled} onClick={onApiKey}>
            API キー
          </Button>
        )}
        {onLogout && provider.authenticated && (
          <Button size="sm" variant="ghost" disabled={disabled} onClick={onLogout}>
            ログアウト
          </Button>
        )}
      </div>
    </li>
  );
}
