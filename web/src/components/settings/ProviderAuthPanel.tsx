"use client";

import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Badge, Button } from "@/components/ui";
import { ProviderIcon } from "@/components/ProviderIcon";
import { ApiError, apiUrl, getJson, sendJson } from "@/lib/client";
import type { AccountProviderId, AccountRecord } from "@/lib/accounts";
import type {
  LoginNotifyDto,
  LoginPromptDto,
  LoginSessionEvent,
} from "@/lib/pi/auth-login";
import type { ProviderAuthDto } from "@/lib/types";
import type { AccountRoutingMode } from "@/lib/provider-routing";

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
  if (provider.subscription)
    return { tone: "success" as const, label: "サブスク認証済" };
  if (provider.authenticated)
    return { tone: "success" as const, label: "認証済" };
  return { tone: "neutral" as const, label: "未設定" };
}

function isAccountProviderId(
  providerId: string,
): providerId is AccountProviderId {
  return (
    providerId === "openai-codex" ||
    providerId === "anthropic" ||
    providerId === "ollama-cloud" ||
    providerId === "openrouter" ||
    providerId === "commandcode" ||
    providerId === "cursor" ||
    providerId === "opencode" ||
    providerId === "opencode-go"
  );
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
  const [creatingFor, setCreatingFor] = useState<AccountProviderId | null>(
    null,
  );
  const [newLabel, setNewLabel] = useState("");
  const [accountBusy, setAccountBusy] = useState(false);
  const [routingBusy, setRoutingBusy] = useState<string | null>(null);
  const [routingErrors, setRoutingErrors] = useState<Record<string, string>>(
    {},
  );
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [authStatuses, setAuthStatuses] = useState<
    Record<string, AccountProviderId[]>
  >({});
  const [ollamaCookieStatuses, setOllamaCookieStatuses] = useState<
    Record<string, boolean>
  >({});
  const [opencodeGoCookieStatuses, setOpencodeGoCookieStatuses] = useState<
    Record<string, boolean>
  >({});
  const [cookieEditingKey, setCookieEditingKey] = useState<string | null>(null);
  const [cookieInput, setCookieInput] = useState("");
  const [cookieBusy, setCookieBusy] = useState<string | null>(null);
  const [cookieErrors, setCookieErrors] = useState<Record<string, string>>({});

  const refreshAccounts = useCallback(async () => {
    try {
      const res = await getJson<{ accounts: AccountRecord[] }>("/api/accounts");
      setAccounts(res.accounts);
      setAccountsError(null);
      // 各アカウントの保存済みプロバイダー（軽量ファイル読み）を取得してバッジへ反映。
      const statuses = await Promise.all(
        res.accounts.map(async (account) => {
          try {
            const status = await getJson<{
              providers: AccountProviderId[];
              ollamaCookieConfigured?: boolean;
              opencodeGoCookieConfigured?: boolean;
            }>(`/api/accounts/${encodeURIComponent(account.id)}/auth-status`);
            return [account.id, status] as const;
          } catch {
            return [
              account.id,
              {
                providers: [] as AccountProviderId[],
                ollamaCookieConfigured: false,
                opencodeGoCookieConfigured: false,
              },
            ] as const;
          }
        }),
      );
      setAuthStatuses(
        Object.fromEntries(
          statuses.map(([id, status]) => [id, status.providers]),
        ),
      );
      setOllamaCookieStatuses(
        Object.fromEntries(
          statuses.map(([id, status]) => [
            id,
            status.ollamaCookieConfigured === true,
          ]),
        ),
      );
      setOpencodeGoCookieStatuses(
        Object.fromEntries(
          statuses.map(([id, status]) => [
            id,
            status.opencodeGoCookieConfigured === true,
          ]),
        ),
      );
    } catch (error) {
      setAccountsError(
        error instanceof ApiError ? error.message : String(error),
      );
    }
  }, []);

  useEffect(() => {
    void refreshAccounts();
  }, [refreshAccounts]);

  useEffect(() => {
    if (!login?.sessionId) return;
    const providerId = login.providerId;
    const es = new EventSource(
      apiUrl(`/api/providers/${encodeURIComponent(providerId)}/login/events`),
    );
    es.addEventListener("notify", (raw) => {
      const payload = JSON.parse((raw as MessageEvent).data) as Extract<
        LoginSessionEvent,
        { type: "notify" }
      >;
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
      const payload = JSON.parse((raw as MessageEvent).data) as Extract<
        LoginSessionEvent,
        { type: "prompt" }
      >;
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
      const payload = JSON.parse((raw as MessageEvent).data) as Extract<
        LoginSessionEvent,
        { type: "done" }
      >;
      es.close();
      if (payload.ok) {
        setLogin((prev) =>
          prev
            ? {
                ...prev,
                busy: false,
                prompt: null,
                status: "ログイン完了",
                warning:
                  "warning" in payload ? (payload.warning ?? null) : null,
                error: null,
              }
            : prev,
        );
        void refreshAccounts();
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
  }, [login?.sessionId, login?.providerId, onChanged, refreshAccounts]);

  async function stopLogin() {
    if (login) {
      try {
        await fetch(
          apiUrl(
            `/api/providers/${encodeURIComponent(login.providerId)}/login/answer`,
          ),
          {
            method: "DELETE",
          },
        );
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
      await sendJson(
        `/api/providers/${encodeURIComponent(login.providerId)}/login/answer`,
        {
          promptId: login.prompt.id,
          value,
        },
      );
      setLogin((prev) =>
        prev
          ? { ...prev, prompt: null, input: "", busy: false, status: "続行中…" }
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

  async function logout(provider: ProviderAuthDto) {
    try {
      await sendJson(
        `/api/providers/${encodeURIComponent(provider.id)}/logout`,
        {},
      );
      onChanged();
    } catch (error) {
      window.alert(error instanceof ApiError ? error.message : String(error));
    }
  }

  async function changeRoutingMode(
    providerId: AccountProviderId,
    mode: AccountRoutingMode,
  ) {
    if (routingBusy) return;
    setRoutingBusy(providerId);
    setRoutingErrors((current) => {
      const next = { ...current };
      delete next[providerId];
      return next;
    });
    try {
      await sendJson(
        `/api/providers/${encodeURIComponent(providerId)}`,
        { accountRoutingMode: mode },
        "PATCH",
      );
      onChanged();
    } catch (error) {
      setRoutingErrors((current) => ({
        ...current,
        [providerId]: error instanceof ApiError ? error.message : String(error),
      }));
    } finally {
      setRoutingBusy(null);
    }
  }

  /** 追加アカウントは、開いているプロバイダーにだけ紐付ける。 */
  async function submitCreateAccount(providerId: AccountProviderId) {
    if (!newLabel.trim()) return;
    setAccountBusy(true);
    try {
      await sendJson("/api/accounts", {
        label: newLabel.trim(),
        providers: [providerId],
      });
      setCreatingFor(null);
      setNewLabel("");
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
      await sendJson(
        `/api/accounts/${encodeURIComponent(id)}`,
        { label: editLabel.trim() },
        "PATCH",
      );
      setEditingAccountId(null);
      await refreshAccounts();
    } catch (error) {
      window.alert(error instanceof ApiError ? error.message : String(error));
    } finally {
      setAccountBusy(false);
    }
  }

  async function removeAccount(account: AccountRecord) {
    if (!window.confirm(`アカウント「${account.label}」を削除しますか？`))
      return;
    setAccountBusy(true);
    try {
      await sendJson(
        `/api/accounts/${encodeURIComponent(account.id)}`,
        {},
        "DELETE",
      );
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
      void refreshAccounts();
      onChanged();
    } catch (error) {
      window.alert(error instanceof ApiError ? error.message : String(error));
    }
  }

  function cookieKey(providerId: string, accountId: string): string {
    return `${providerId}:${accountId}`;
  }

  function openCookieEditor(providerId: string, accountId: string) {
    setCookieEditingKey(cookieKey(providerId, accountId));
    setCookieInput("");
    setCookieErrors((current) => {
      const next = { ...current };
      delete next[cookieKey(providerId, accountId)];
      return next;
    });
  }

  async function saveCookie(providerId: string, accountId: string) {
    if (!cookieInput.trim() || cookieBusy) return;
    const key = cookieKey(providerId, accountId);
    setCookieBusy(key);
    setCookieErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    try {
      await sendJson(
        `/api/accounts/${encodeURIComponent(accountId)}/${
          providerId === "ollama-cloud" ? "ollama-cookie" : "opencode-go-cookie"
        }`,
        {
          cookies: cookieInput,
        },
      );
      setCookieInput("");
      setCookieEditingKey(null);
      await refreshAccounts();
      onChanged();
    } catch (error) {
      setCookieErrors((current) => ({
        ...current,
        [key]: error instanceof ApiError ? error.message : String(error),
      }));
    } finally {
      setCookieBusy(null);
    }
  }

  async function removeCookie(
    providerId: string,
    accountId: string,
    label: string,
  ) {
    const name = providerId === "ollama-cloud" ? "Ollama" : "OpenCode Go";
    if (
      cookieBusy ||
      !window.confirm(`「${label}」の ${name} cookie を削除しますか？`)
    )
      return;
    const key = cookieKey(providerId, accountId);
    setCookieBusy(key);
    setCookieErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    try {
      await sendJson(
        `/api/accounts/${encodeURIComponent(accountId)}/${
          providerId === "ollama-cloud" ? "ollama-cookie" : "opencode-go-cookie"
        }`,
        {},
        "DELETE",
      );
      setCookieEditingKey(null);
      setCookieInput("");
      await refreshAccounts();
      onChanged();
    } catch (error) {
      setCookieErrors((current) => ({
        ...current,
        [key]: error instanceof ApiError ? error.message : String(error),
      }));
    } finally {
      setCookieBusy(null);
    }
  }

  function renderAccountControls(provider: ProviderAuthDto): ReactNode {
    if (!isAccountProviderId(provider.id)) return null;
    const providerId = provider.id;
    const providerAccounts =
      accounts?.filter(
        (account) =>
          Array.isArray(account.providers) &&
          account.providers.includes(providerId),
      ) ?? [];
    const isCreating = creatingFor === providerId;
    // OAuth 対応なら OAuth、API キー専用プロバイダーは API キー入力へ
    const accountAuthType: "api_key" | "oauth" | null =
      provider.oauthAvailable === true || provider.methods?.includes("oauth")
        ? "oauth"
        : provider.methods?.includes("api_key")
          ? "api_key"
          : null;
    const mode = provider.accountRoutingMode ?? "separate";
    const savingMode = routingBusy === providerId;
    const modeDisabled = Boolean(login) || accountBusy || Boolean(routingBusy);

    return (
      <section
        aria-label={`${provider.name} の追加アカウント`}
        className="mt-3 border-t border-border pt-3"
      >
        <div className="mb-2" aria-busy={savingMode || undefined}>
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-muted">
            <input
              type="checkbox"
              checked={mode === "integrated"}
              disabled={modeDisabled}
              onChange={(event) =>
                void changeRoutingMode(
                  providerId,
                  event.target.checked ? "integrated" : "separate",
                )
              }
              className="h-4 w-4 accent-accent"
            />
            <span>統合</span>
          </label>
          {routingErrors[providerId] && (
            <p className="text-xs text-danger" role="alert">
              {routingErrors[providerId]}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-xs font-semibold text-muted">
              ログインアカウント
            </h3>
            <p className="mt-0.5 text-xs text-muted">
              このプロバイダー用のアカウントを追加・管理します。
            </p>
          </div>
          {!isCreating && (
            <Button
              size="sm"
              variant="ghost"
              disabled={Boolean(login) || accountBusy}
              onClick={() => {
                setCreatingFor(providerId);
                setNewLabel("");
              }}
            >
              アカウントを追加
            </Button>
          )}
        </div>
        {accountsError && (
          <p className="mt-2 text-xs text-danger">{accountsError}</p>
        )}
        {accounts === null ? (
          <p className="mt-2 text-xs text-muted">読み込み中…</p>
        ) : (
          <>
            {providerAccounts.length === 0 && !isCreating && (
              <p className="mt-2 text-xs text-muted">
                アカウントを追加してログインしてください
              </p>
            )}
            {providerAccounts.length > 0 && (
              <ul className="mt-2 space-y-1.5">
                {providerAccounts.map((account) => {
                  const cookieConfigured =
                    providerId === "ollama-cloud"
                      ? ollamaCookieStatuses[account.id] === true
                      : providerId === "opencode-go"
                        ? opencodeGoCookieStatuses[account.id] === true
                        : false;
                  const piAuthenticated =
                    authStatuses[account.id]?.includes(providerId) === true;
                  const authenticated =
                    piAuthenticated ||
                    (providerId === "opencode-go" && cookieConfigured);
                  const currentCookieKey = cookieKey(providerId, account.id);
                  const cookieEditing = cookieEditingKey === currentCookieKey;
                  const cookieAccountBusy = cookieBusy === currentCookieKey;
                  return (
                    <li
                      key={account.id}
                      className="rounded-xl bg-surface-2 px-3 py-2"
                    >
                      {editingAccountId === account.id ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            className="min-w-0 flex-1 rounded-xl border border-border bg-surface px-3 py-1.5 text-sm outline-none focus:border-accent"
                            value={editLabel}
                            onChange={(event) =>
                              setEditLabel(event.target.value)
                            }
                            aria-label={`${provider.name} のアカウント名`}
                            autoFocus
                          />
                          <Button
                            size="sm"
                            disabled={accountBusy || !editLabel.trim()}
                            onClick={() => void saveAccountLabel(account.id)}
                          >
                            保存
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setEditingAccountId(null)}
                          >
                            キャンセル
                          </Button>
                        </div>
                      ) : (
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">
                            {account.label}
                          </span>
                          {account.note && (
                            <span className="text-xs text-muted">
                              {account.note}
                            </span>
                          )}
                          <Badge tone={authenticated ? "success" : "neutral"}>
                            {authenticated ? "認証済" : "未ログイン"}
                          </Badge>
                        </div>
                      )}
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {accountAuthType && (
                          <Button
                            size="sm"
                            disabled={Boolean(login) || accountBusy}
                            onClick={() =>
                              void beginLogin(
                                provider,
                                accountAuthType,
                                account.id,
                              )
                            }
                          >
                            {authenticated ? "再ログイン" : "ログイン"}
                          </Button>
                        )}
                        {piAuthenticated && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={Boolean(login) || accountBusy}
                            onClick={() =>
                              void logoutFor(providerId, account.id)
                            }
                          >
                            ログアウト
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={accountBusy}
                          onClick={() => {
                            setEditingAccountId(account.id);
                            setEditLabel(account.label);
                          }}
                        >
                          名前変更
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={accountBusy}
                          onClick={() => void removeAccount(account)}
                        >
                          削除
                        </Button>
                      </div>
                      {(providerId === "ollama-cloud" ||
                        providerId === "opencode-go") && (
                        <div className="mt-2 border-t border-border pt-2">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <p className="text-xs font-semibold text-muted">
                                {providerId === "ollama-cloud"
                                  ? "Ollama cookie"
                                  : "OpenCode Go cookie"}
                              </p>
                              <p
                                className="mt-0.5 text-xs text-muted"
                                role="status"
                              >
                                {cookieConfigured
                                  ? "このアカウントの cookie を登録済み"
                                  : "利用量表示には cookie が必要です"}
                              </p>
                            </div>
                            <div className="flex flex-wrap items-center gap-1">
                              <Badge
                                tone={cookieConfigured ? "success" : "neutral"}
                              >
                                {cookieConfigured ? "登録済み" : "未登録"}
                              </Badge>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={
                                  Boolean(login) ||
                                  accountBusy ||
                                  Boolean(cookieBusy)
                                }
                                onClick={() =>
                                  openCookieEditor(providerId, account.id)
                                }
                              >
                                {cookieConfigured ? "更新" : "登録"}
                              </Button>
                              {cookieConfigured && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={
                                    Boolean(login) ||
                                    accountBusy ||
                                    Boolean(cookieBusy)
                                  }
                                  onClick={() =>
                                    void removeCookie(
                                      providerId,
                                      account.id,
                                      account.label,
                                    )
                                  }
                                >
                                  削除
                                </Button>
                              )}
                            </div>
                          </div>
                          {cookieEditing && (
                            <form
                              className="mt-2 flex flex-col gap-2"
                              onSubmit={(event) => {
                                event.preventDefault();
                                void saveCookie(providerId, account.id);
                              }}
                            >
                              <label
                                htmlFor={`${providerId}-cookie-${account.id}`}
                                className="text-xs text-muted"
                              >
                                Netscape 形式の cookie
                              </label>
                              <textarea
                                id={`${providerId}-cookie-${account.id}`}
                                rows={5}
                                value={cookieInput}
                                onChange={(event) =>
                                  setCookieInput(event.target.value)
                                }
                                placeholder="# Netscape HTTP Cookie File"
                                spellCheck={false}
                                autoComplete="off"
                                className="w-full resize-y rounded-xl border border-border bg-surface px-3 py-2 font-mono text-xs outline-none focus:border-accent"
                                aria-describedby={`${providerId}-cookie-help-${account.id}`}
                                disabled={cookieAccountBusy}
                                autoFocus
                              />
                              <p
                                id={`${providerId}-cookie-help-${account.id}`}
                                className="text-xs text-muted"
                              >
                                {providerId === "ollama-cloud"
                                  ? "ollama.com"
                                  : "opencode.ai"}{" "}
                                の cookie
                                を貼り付けてください。保存後、本文は画面に表示しません。
                              </p>
                              {cookieErrors[currentCookieKey] && (
                                <p className="text-xs text-danger" role="alert">
                                  {cookieErrors[currentCookieKey]}
                                </p>
                              )}
                              <div className="flex gap-2">
                                <Button
                                  type="submit"
                                  size="sm"
                                  busy={cookieAccountBusy}
                                  disabled={
                                    !cookieInput.trim() ||
                                    Boolean(cookieBusy && !cookieAccountBusy)
                                  }
                                >
                                  保存
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  disabled={cookieAccountBusy}
                                  onClick={() => {
                                    setCookieEditingKey(null);
                                    setCookieInput("");
                                  }}
                                >
                                  キャンセル
                                </Button>
                              </div>
                            </form>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
        {isCreating && (
          <div className="mt-2 rounded-xl bg-surface-2 p-3">
            <label
              htmlFor={`new-account-label-${providerId}`}
              className="text-xs text-muted"
            >
              アカウント名
            </label>
            <input
              id={`new-account-label-${providerId}`}
              value={newLabel}
              onChange={(event) => setNewLabel(event.target.value)}
              placeholder="例: 仕事用"
              className="mb-3 mt-1 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
              autoFocus
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                busy={accountBusy}
                disabled={!newLabel.trim()}
                onClick={() => void submitCreateAccount(providerId)}
              >
                追加
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={accountBusy}
                onClick={() => setCreatingFor(null)}
              >
                キャンセル
              </Button>
            </div>
          </div>
        )}
      </section>
    );
  }

  const orderedProviders = [...providers].sort(
    (a, b) => Number(b.authenticated) - Number(a.authenticated),
  );

  return (
    <div className="space-y-4">
      <div>
        <h2 className="mb-2 text-sm font-semibold">プロバイダー</h2>
        <p className="mb-3 text-xs text-muted">
          Claude Pro/Max（Anthropic）、ChatGPT Plus/Pro（OpenAI
          Codex）、Cursor、OpenCode、Command Code（Go プラン可）、および Ollama
          Cloud / OpenRouter に対応しています。マルチアカウント対応プロバイダーは
          アカウントごとに管理します。共有プロバイダーでは環境変数または
          ~/.pi/agent/auth.json を引き続き使えます。Command Code は{" "}
          <span className="font-mono">COMMANDCODE_API_KEY</span> /{" "}
          <span className="font-mono">~/.commandcode/auth.json</span>、Ollama
          Cloud は <span className="font-mono">OLLAMA_API_KEY</span>{" "}
          でも設定できます。Ollama Cloud はアカウントごとに cookie
          も登録できます。OpenCode Go の利用量にもアカウント別 cookie
          を登録できます。
        </p>
        <ul className="space-y-1.5">
          {orderedProviders.length === 0 && (
            <li className="text-sm text-muted">プロバイダーが見つかりません</li>
          )}
          {orderedProviders.map((provider) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              disabled={Boolean(login)}
              onOAuth={
                provider.oauthAvailable
                  ? () => void beginLogin(provider, "oauth")
                  : undefined
              }
              onApiKey={
                provider.methods?.includes("api_key")
                  ? () => void beginLogin(provider, "api_key")
                  : undefined
              }
              onLogout={() => void logout(provider)}
              accountControls={renderAccountControls(provider)}
            />
          ))}
        </ul>
      </div>

      {login && (
        <div className="rounded-2xl border border-border bg-surface-2 p-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">
              {login.providerName} —{" "}
              {login.authType === "oauth" ? "サブスクログイン" : "API キー"}
              {login.accountId && (
                <span className="ml-1 text-xs font-normal text-muted">
                  （アカウント:{" "}
                  {accounts?.find((a) => a.id === login.accountId)?.label ??
                    login.accountId}
                  ）
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
              <a
                className="text-accent underline"
                href={login.authUrl}
                target="_blank"
                rel="noreferrer"
              >
                {login.authUrl}
              </a>
            </p>
          )}
          {login.deviceCode && (
            <div className="mt-3 rounded-xl border border-border bg-surface p-3 text-sm">
              <p>
                コード:{" "}
                <span className="font-mono text-base font-semibold">
                  {login.deviceCode.userCode}
                </span>
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
                      <span className="ml-2 text-xs text-muted">
                        {option.description}
                      </span>
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
              <label className="text-xs text-muted">
                {login.prompt.prompt.message}
              </label>
              <input
                className="rounded-xl border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
                type={
                  login.prompt.prompt.type === "secret" ? "password" : "text"
                }
                value={login.input}
                placeholder={login.prompt.prompt.placeholder}
                disabled={login.busy}
                onChange={(event) =>
                  setLogin((prev) =>
                    prev ? { ...prev, input: event.target.value } : prev,
                  )
                }
                autoFocus
              />
              <Button
                type="submit"
                disabled={login.busy || !login.input.trim()}
              >
                送信
              </Button>
            </form>
          )}
          {login.warning && (
            <p className="mt-2 text-sm text-warning">{login.warning}</p>
          )}
          {login.error && (
            <p className="mt-2 text-sm text-danger">{login.error}</p>
          )}
        </div>
      )}
    </div>
  );
}

function ProviderRow({
  provider,
  disabled,
  onOAuth,
  onApiKey,
  onLogout,
  accountControls,
}: {
  provider: ProviderAuthDto;
  disabled?: boolean;
  onOAuth?: () => void;
  onApiKey?: () => void;
  onLogout?: () => void;
  accountControls?: ReactNode;
}) {
  const accountManaged = isAccountProviderId(provider.id);
  const badge = accountManaged
    ? { tone: "neutral" as const, label: "アカウントで管理" }
    : authBadge(provider);
  const hint = accountManaged ? null : sourceHint(provider);
  return (
    <li className="rounded-xl border border-border bg-surface px-2 py-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
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
          {!accountManaged && onOAuth && (
            <Button size="sm" disabled={disabled} onClick={onOAuth}>
              ログイン
            </Button>
          )}
          {!accountManaged && onApiKey && (
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={onApiKey}
            >
              API キー
            </Button>
          )}
          {!accountManaged && onLogout && provider.authenticated && (
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={onLogout}
            >
              ログアウト
            </Button>
          )}
        </div>
      </div>
      {accountControls}
    </li>
  );
}
