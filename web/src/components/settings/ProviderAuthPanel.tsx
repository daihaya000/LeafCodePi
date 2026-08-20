"use client";

import { useEffect, useState } from "react";
import { Badge, Button, cx } from "@/components/ui";
import { ApiError, apiUrl, sendJson } from "@/lib/client";
import type { LoginNotifyDto, LoginPromptDto, LoginSessionEvent } from "@/lib/pi/auth-login";
import type { ProviderAuthDto } from "@/lib/types";

type LoginUiState = {
  providerId: string;
  providerName: string;
  authType: "api_key" | "oauth";
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
  if (provider.subscription) return "Claude Pro/Max または ChatGPT サブスク";
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

  async function beginLogin(provider: ProviderAuthDto, authType: "api_key" | "oauth") {
    setLogin({
      providerId: provider.id,
      providerName: provider.name,
      authType,
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
        `/api/providers/${encodeURIComponent(provider.id)}/login`,
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

  const highlighted = providers.filter((p) => p.highlighted);
  const others = providers.filter((p) => !p.highlighted);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="mb-2 text-sm font-semibold">サブスクリプション（推奨）</h2>
        <p className="mb-3 text-xs text-muted">
          Anthropic は Claude Pro/Max、OpenAI Codex は ChatGPT Plus/Pro のブラウザログインに対応しています。API
          キーなしで使えます。
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
              onOAuth={() => void beginLogin(provider, "oauth")}
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
          <span className="text-sm font-medium">{provider.name}</span>
          <span className="font-mono text-xs text-muted">{provider.id}</span>
          <Badge tone={badge.tone}>{badge.label}</Badge>
        </div>
        {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
      </div>
      <div className="flex flex-wrap gap-1">
        {onOAuth && (
          <Button size="sm" disabled={disabled} onClick={onOAuth}>
            サブスクでログイン
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
