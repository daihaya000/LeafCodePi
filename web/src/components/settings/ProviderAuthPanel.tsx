"use client";

import { memo, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, GripVertical } from "lucide-react";
import { Badge, Button, Switch, cx } from "@/components/ui";
import { ProviderIcon } from "@/components/ProviderIcon";
import { ApiError, apiUrl, getJson, sendJson } from "@/lib/client";
import type {
  AccountCredentialKind,
  AccountProviderId,
  AccountRecord,
} from "@/lib/accounts";
import type {
  LoginNotifyDto,
  LoginPromptDto,
  LoginSessionEvent,
} from "@/lib/pi/auth-login";
import type { ProviderAuthDto } from "@/lib/types";
import type { AccountRoutingMode } from "@/lib/provider-routing";
import {
  clampPercent,
  creditUsageParts,
  formatCreditAmount,
  formatResetsIn,
  percentTone,
  type CodexBarCredits,
  type CodexBarProvider,
  type CodexBarUsage,
  type UsageTone,
} from "@/lib/codexbar";
import { REMOTE_OAUTH_HINT } from "@/lib/oauth-loopback";

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

type ResetCreditDto = {
  id: string;
  title: string | null;
  expiresAt: string | null;
};

type ResetCreditsListResponse = {
  credits: ResetCreditDto[];
};

type ResetCreditsConsumeResponse = {
  ok: boolean;
  message: string;
};

type ModelProviderSummary = {
  id: string;
  enabled: boolean;
};

/** アカウント別 cookie を登録できるプロバイダーの UI 定義。 */
type CookieUi = {
  route: string;
  title: string;
  domain: string;
  providerName: string;
  /** 未登録時に何のために必要かを示す一文。 */
  missingHint: string;
};

const COOKIE_UI: Partial<Record<AccountProviderId, CookieUi>> = {
  "ollama-cloud": {
    route: "ollama-cookie",
    title: "Ollama cookie",
    domain: "ollama.com",
    providerName: "Ollama",
    missingHint: "利用量表示には cookie が必要です",
  },
  "opencode-go": {
    route: "opencode-go-cookie",
    title: "OpenCode Go cookie",
    domain: "opencode.ai",
    providerName: "OpenCode Go",
    missingHint: "利用量表示には cookie が必要です",
  },
  anthropic: {
    route: "anthropic-cookie",
    title: "Anthropic Console cookie",
    domain: "platform.claude.com",
    providerName: "Anthropic",
    // サブスク（OAuth）口座は不要。API キー口座のクレジット残高だけが cookie を要する。
    missingHint: "API キー口座のクレジット残高表示に必要です",
  },
};

/** ログイン方式が 1 つだけのプロバイダーは従来どおりのラベルにする。 */
function accountLoginLabel(
  authType: "api_key" | "oauth",
  methodCount: number,
  authenticated: boolean,
): string {
  if (methodCount > 1) {
    return authType === "oauth" ? "サブスクでログイン" : "API キー";
  }
  return authenticated ? "再ログイン" : "ログイン";
}

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
    providerId === "opencode-go" ||
    providerId === "orcarouter"
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

const usageBarClass: Record<UsageTone, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  danger: "bg-danger",
};

const usageTextClass: Record<UsageTone, string> = {
  ok: "text-muted",
  warn: "text-warning",
  danger: "text-danger",
};

function UsageBar({ percent }: { percent: number | null | undefined }) {
  const normalizedPercent = percent ?? null;
  const tone = percentTone(normalizedPercent);
  return (
    <div className="mt-1">
      <div className="mb-1 flex items-center justify-between gap-2 text-xs">
        <span className="text-muted">使用量</span>
        <span className={cx("font-mono", usageTextClass[tone])}>
          {normalizedPercent === null
            ? "—"
            : `${Math.round(normalizedPercent)}%`}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
        <div
          className={cx(
            "h-full rounded-full transition-all",
            usageBarClass[tone],
          )}
          style={{ width: `${clampPercent(normalizedPercent)}%` }}
        />
      </div>
    </div>
  );
}

/** 使用量%が無い口座（API キーの従量課金など）でも残高/利用額は行に出す。 */
function CreditsLine({ credits }: { credits: CodexBarCredits }) {
  const amounts = creditUsageParts(credits);
  if (credits.balance !== null) {
    amounts.push(`残高 ${formatCreditAmount(credits.balance)}`);
  }
  if (amounts.length === 0) return null;

  return (
    <p className="mt-1 flex items-center justify-between gap-2 text-xs">
      <span className="truncate text-muted">
        {credits.title ?? "利用クレジット"}
      </span>
      <span className="shrink-0 font-mono text-text">{amounts.join(" · ")}</span>
    </p>
  );
}

function formatResetExpiry(expiresAt: string | null): string {
  if (!expiresAt) return "期限不明";
  const now = Date.now();
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) return "期限不明";
  if (ms <= now) return "期限切れ間近";
  return `期限 ${formatResetsIn(expiresAt, now) ?? expiresAt}`;
}

function resetCreditKey(provider: CodexBarProvider): string {
  return (
    provider.instanceId ??
    `${provider.accountId ?? "default"}:${provider.id}`
  );
}

const RESET_CREDIT_DAY_MS = 24 * 60 * 60 * 1000;

function earliestResetExpiry(
  credits: readonly Pick<ResetCreditDto, "expiresAt">[],
): string | null {
  let earliest: { expiresAt: string; timestamp: number } | null = null;
  for (const credit of credits) {
    if (!credit.expiresAt) continue;
    const timestamp = Date.parse(credit.expiresAt);
    if (!Number.isFinite(timestamp)) continue;
    if (!earliest || timestamp < earliest.timestamp) {
      earliest = { expiresAt: credit.expiresAt, timestamp };
    }
  }
  return earliest?.expiresAt ?? null;
}

function formatResetCreditRemainingDays(expiresAt: string | null): string | null {
  if (!expiresAt) return null;
  const remainingDays = Math.ceil(
    (Date.parse(expiresAt) - Date.now()) / RESET_CREDIT_DAY_MS,
  );
  if (!Number.isFinite(remainingDays)) return null;
  return remainingDays > 0
    ? `最短期限まであと${remainingDays}日`
    : "最短期限が切れています";
}

function ResetCreditExpiry({ accountId }: { accountId?: string | null }) {
  const [expiresAt, setExpiresAt] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getJson<ResetCreditsListResponse>(
      "/api/codexbar/reset-credits",
      accountId ? { accountId } : undefined,
    )
      .then((result) => {
        if (active) setExpiresAt(earliestResetExpiry(result.credits ?? []));
      })
      .catch(() => {
        if (active) setExpiresAt(null);
      });
    return () => {
      active = false;
    };
  }, [accountId]);

  const remainingDays = formatResetCreditRemainingDays(expiresAt);
  return remainingDays ? (
    <p className="text-xs text-muted">リセット権: {remainingDays}</p>
  ) : null;
}

function ResetCreditsControl({
  provider,
  busy,
  status,
  onRedeem,
}: {
  provider: CodexBarProvider;
  busy: boolean;
  status: string | null;
  onRedeem: (provider: CodexBarProvider) => void;
}) {
  const available = provider.resetCreditsAvailable ?? 0;
  if (provider.id !== "openai-codex" || available <= 0) return null;
  return (
    <div className="mt-1.5 flex flex-col gap-1 border-t border-border pt-1.5">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-muted">
          リセット権 <span className="font-mono text-text">{available}</span>
        </span>
        <Button
          size="sm"
          variant="outline"
          busy={busy}
          disabled={busy}
          onClick={() => onRedeem(provider)}
          aria-label="Codex の使用量リセット権を使う"
        >
          {busy ? "処理中…" : "使う"}
        </Button>
      </div>
      <ResetCreditExpiry accountId={provider.accountId} />
      {status && (
        <p role="status" className="text-xs text-muted">
          {status}
        </p>
      )}
    </div>
  );
}

function findProviderUsage(
  usage: CodexBarUsage | null,
  providerId: string,
  accountId: string | null = null,
): CodexBarProvider | null {
  if (!usage || !Array.isArray(usage.providers)) return null;
  return (
    usage.providers.find(
      (provider) =>
        provider.id === providerId &&
        (provider.accountId ?? null) === accountId,
    ) ?? null
  );
}

export const ProviderAuthPanel = memo(function ProviderAuthPanel({
  providers,
  onChanged,
}: {
  providers: ProviderAuthDto[];
  onChanged: () => void;
}) {
  const [login, setLogin] = useState<LoginUiState | null>(null);
  const loginGenerationRef = useRef(0);
  // アカウント（docs/plans/multi-account.md）。null = 未取得、[] = 取得済みで空。
  const [accounts, setAccounts] = useState<AccountRecord[] | null>(null);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const accountsRequestGenerationRef = useRef(0);
  const [creatingFor, setCreatingFor] = useState<AccountProviderId | null>(
    null,
  );
  const [newLabel, setNewLabel] = useState("");
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountOrderBusy, setAccountOrderBusy] = useState(false);
  const [accountOrderError, setAccountOrderError] = useState<string | null>(null);
  const [draggingAccountId, setDraggingAccountId] = useState<string | null>(null);
  const [dragOverAccountId, setDragOverAccountId] = useState<string | null>(null);
  const [reorderAnnouncement, setReorderAnnouncement] = useState("");
  const [routingBusy, setRoutingBusy] = useState<string | null>(null);
  const [routingErrors, setRoutingErrors] = useState<Record<string, string>>(
    {},
  );
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [authStatuses, setAuthStatuses] = useState<
    Record<string, AccountProviderId[]>
  >({});
  /** `${providerId}:${accountId}` → cookie 登録済み（Ollama / OpenCode Go / Anthropic Console）。 */
  const [cookieStatuses, setCookieStatuses] = useState<Record<string, boolean>>(
    {},
  );
  /** `${providerId}:${accountId}` → 保存済み資格情報の種類（oauth = サブスク / api_key）。 */
  const [credentialKinds, setCredentialKinds] = useState<
    Record<string, AccountCredentialKind>
  >({});
  /** `${providerId}:${accountId}` → API キー口座の基準残高（USD、未設定は null）。 */
  const [creditBaselines, setCreditBaselines] = useState<
    Record<string, number | null>
  >({});
  /** 基準残高の入力中テキスト（未編集のキーは持たない）。 */
  const [baselineInputs, setBaselineInputs] = useState<Record<string, string>>(
    {},
  );
  const [baselineBusy, setBaselineBusy] = useState<string | null>(null);
  const [baselineErrors, setBaselineErrors] = useState<Record<string, string>>(
    {},
  );
  const [cookieEditingKey, setCookieEditingKey] = useState<string | null>(null);
  const [cookieInput, setCookieInput] = useState("");
  const [cookieBusy, setCookieBusy] = useState<string | null>(null);
  const [cookieErrors, setCookieErrors] = useState<Record<string, string>>({});
  const [codexBarUsage, setCodexBarUsage] = useState<CodexBarUsage | null>(null);
  const [enabledProviderOrder, setEnabledProviderOrder] = useState<string[]>([]);
  const [resetBusyKey, setResetBusyKey] = useState<string | null>(null);
  const [resetStatusByKey, setResetStatusByKey] = useState<Record<string, string>>({});
  const loadCodexBarUsage = useCallback(
    (force = false) =>
      getJson<CodexBarUsage>(
        "/api/codexbar/usage",
        force ? { refresh: "1" } : undefined,
      ),
    [],
  );

  useEffect(() => {
    if (providers.length === 0) {
      setCodexBarUsage(null);
      return;
    }

    let active = true;
    void loadCodexBarUsage()
      .then((usage) => {
        if (active) setCodexBarUsage(usage);
      })
      .catch(() => {
        if (active) setCodexBarUsage(null);
      });
    return () => {
      active = false;
    };
  }, [loadCodexBarUsage, providers]);

  useEffect(() => {
    if (providers.length === 0) {
      setEnabledProviderOrder([]);
      return;
    }

    let active = true;
    void getJson<{ providers?: ModelProviderSummary[] }>("/api/provider-models")
      .then((result) => {
        if (!active) return;
        const order: string[] = [];
        const seen = new Set<string>();
        for (const provider of result.providers ?? []) {
          if (!provider.enabled || seen.has(provider.id)) continue;
          seen.add(provider.id);
          order.push(provider.id);
        }
        setEnabledProviderOrder(order);
      })
      .catch(() => {
        if (active) setEnabledProviderOrder([]);
      });
    return () => {
      active = false;
    };
  }, [providers]);

  const redeemResetCredit = useCallback(
    async (provider: CodexBarProvider) => {
      if (provider.id !== "openai-codex" || resetBusyKey) return;
      const key = resetCreditKey(provider);
      setResetBusyKey(key);
      setResetStatusByKey((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });

      try {
        const list = await getJson<ResetCreditsListResponse>(
          "/api/codexbar/reset-credits",
          provider.accountId
            ? { accountId: provider.accountId }
            : undefined,
        );
        const credit = list.credits?.[0];
        if (!credit) {
          setResetStatusByKey((current) => ({
            ...current,
            [key]: "利用可能なリセット権がありません。",
          }));
          return;
        }

        const usageLine =
          provider.usedPercent == null
            ? "現在の使用率: —"
            : `現在の使用率: ${Math.round(provider.usedPercent)}%`;
        const title = credit.title?.trim() || "使用量リセット";
        const confirmed = window.confirm(
          `${title} を消費します。この操作は取り消せません。\n\n${usageLine}\n${formatResetExpiry(credit.expiresAt)}\n\nリセット権を使いますか？`,
        );
        if (!confirmed) {
          setResetStatusByKey((current) => ({
            ...current,
            [key]: "キャンセルしました。",
          }));
          return;
        }

        const result = await sendJson<ResetCreditsConsumeResponse>(
          "/api/codexbar/reset-credits",
          {
            creditId: credit.id,
            accountId: provider.accountId ?? undefined,
          },
        );
        setResetStatusByKey((current) => ({
          ...current,
          [key]: result.message,
        }));
        if (result.ok) {
          try {
            setCodexBarUsage(await loadCodexBarUsage(true));
          } catch {
            // Keep the successful result visible if the follow-up refresh fails.
          }
        }
      } catch (error) {
        const message =
          error instanceof ApiError
            ? error.message
            : error instanceof Error
              ? error.message
              : "リセット権の使用に失敗しました";
        setResetStatusByKey((current) => ({ ...current, [key]: message }));
      } finally {
        setResetBusyKey((current) => (current === key ? null : current));
      }
    },
    [loadCodexBarUsage, resetBusyKey],
  );

  const refreshAccounts = useCallback(async () => {
    const generation = ++accountsRequestGenerationRef.current;
    try {
      const res = await getJson<{ accounts: AccountRecord[] }>(
        "/api/accounts",
        undefined,
        { coalesce: false },
      );
      if (generation !== accountsRequestGenerationRef.current) return;
      setAccounts(res.accounts);
      setAccountsError(null);
      // 各アカウントの保存済みプロバイダー（軽量ファイル読み）を取得してバッジへ反映。
      const statuses = await Promise.all(
        res.accounts.map(async (account) => {
          try {
            const status = await getJson<{
              providers: AccountProviderId[];
              credentialKinds?: Partial<
                Record<AccountProviderId, AccountCredentialKind>
              >;
              anthropicCreditBaseline?: number | null;
              ollamaCookieConfigured?: boolean;
              opencodeGoCookieConfigured?: boolean;
              anthropicCookieConfigured?: boolean;
            }>(`/api/accounts/${encodeURIComponent(account.id)}/auth-status`);
            return [account.id, status] as const;
          } catch {
            return [
              account.id,
              {
                providers: [] as AccountProviderId[],
                credentialKinds: {} as Partial<
                  Record<AccountProviderId, AccountCredentialKind>
                >,
                anthropicCreditBaseline: null,
                ollamaCookieConfigured: false,
                opencodeGoCookieConfigured: false,
                anthropicCookieConfigured: false,
              },
            ] as const;
          }
        }),
      );
      if (generation !== accountsRequestGenerationRef.current) return;
      setAuthStatuses(
        Object.fromEntries(
          statuses.map(([id, status]) => [id, status.providers]),
        ),
      );
      setCookieStatuses(
        Object.fromEntries(
          statuses.flatMap(([id, status]) => [
            [
              cookieKey("ollama-cloud", id),
              status.ollamaCookieConfigured === true,
            ],
            [
              cookieKey("opencode-go", id),
              status.opencodeGoCookieConfigured === true,
            ],
            [
              cookieKey("anthropic", id),
              status.anthropicCookieConfigured === true,
            ],
          ]),
        ),
      );
      setCredentialKinds(
        Object.fromEntries(
          statuses.flatMap(([id, status]) =>
            Object.entries(status.credentialKinds ?? {}).map(
              ([providerId, kind]) => [cookieKey(providerId, id), kind],
            ),
          ),
        ),
      );
      setCreditBaselines(
        Object.fromEntries(
          statuses.map(([id, status]) => [
            cookieKey("anthropic", id),
            status.anthropicCreditBaseline ?? null,
          ]),
        ),
      );
    } catch (error) {
      if (generation !== accountsRequestGenerationRef.current) return;
      setAccountsError(
        error instanceof ApiError ? error.message : String(error),
      );
    }
  }, []);

  useEffect(() => {
    if (!providers.some((provider) => isAccountProviderId(provider.id))) {
      setAccounts([]);
      return;
    }
    void refreshAccounts();
  }, [providers, refreshAccounts]);

  useEffect(() => {
    if (!login?.sessionId) return;
    const sessionId = login.sessionId;
    const providerId = login.providerId;
    const generation = loginGenerationRef.current;
    let closed = false;
    let finishTimer: number | undefined;
    const isCurrent = () =>
      !closed && loginGenerationRef.current === generation;
    const updateLogin = (update: (current: LoginUiState) => LoginUiState) => {
      if (loginGenerationRef.current !== generation) return;
      setLogin((prev) =>
        prev?.sessionId === sessionId ? update(prev) : prev,
      );
    };
    const es = new EventSource(
      apiUrl(
        `/api/providers/${encodeURIComponent(providerId)}/login/events?sessionId=${encodeURIComponent(sessionId)}`,
      ),
    );
    // EventSource reconnects replay history; open each OAuth/device URL once.
    const openedAuthUrls = new Set<string>();
    es.addEventListener("notify", (raw) => {
      if (!isCurrent()) return;
      let payload: Extract<LoginSessionEvent, { type: "notify" }>;
      try {
        payload = JSON.parse((raw as MessageEvent).data) as Extract<
          LoginSessionEvent,
          { type: "notify" }
        >;
      } catch {
        return;
      }
      const event = payload.event;
      if (event.type === "auth_url") {
        updateLogin((prev) => ({
          ...prev,
          authUrl: event.url,
          status: event.instructions ?? "ブラウザでログインしてください",
        }));
        if (!openedAuthUrls.has(event.url)) {
          openedAuthUrls.add(event.url);
          window.open(event.url, "_blank", "noopener,noreferrer");
        }
      } else if (event.type === "device_code") {
        updateLogin((prev) => ({
          ...prev,
          deviceCode: event,
          status: "デバイスコードでログインしてください",
        }));
        if (!openedAuthUrls.has(event.verificationUri)) {
          openedAuthUrls.add(event.verificationUri);
          window.open(event.verificationUri, "_blank", "noopener,noreferrer");
        }
      } else if (event.type === "progress" || event.type === "info") {
        updateLogin((prev) => ({ ...prev, status: event.message }));
      }
    });
    es.addEventListener("prompt", (raw) => {
      if (!isCurrent()) return;
      let payload: Extract<LoginSessionEvent, { type: "prompt" }>;
      try {
        payload = JSON.parse((raw as MessageEvent).data) as Extract<
          LoginSessionEvent,
          { type: "prompt" }
        >;
      } catch {
        return;
      }
      updateLogin((prev) => ({
        ...prev,
        prompt: { id: payload.id, prompt: payload.prompt },
        input: "",
        busy: false,
        status: payload.prompt.message,
      }));
    });
    es.addEventListener("done", (raw) => {
      if (!isCurrent()) return;
      let payload: Extract<LoginSessionEvent, { type: "done" }>;
      try {
        payload = JSON.parse((raw as MessageEvent).data) as Extract<
          LoginSessionEvent,
          { type: "done" }
        >;
      } catch {
        closed = true;
        es.close();
        updateLogin((prev) => ({
          ...prev,
          busy: false,
          error: "ログイン完了イベントを解釈できませんでした",
          status: "失敗",
        }));
        return;
      }
      closed = true;
      es.close();
      if (payload.ok) {
        updateLogin((prev) => ({
          ...prev,
          busy: false,
          prompt: null,
          status: "ログイン完了",
          warning: "warning" in payload ? (payload.warning ?? null) : null,
          error: null,
        }));
        void refreshAccounts();
        onChanged();
        finishTimer = window.setTimeout(() => {
          if (loginGenerationRef.current !== generation) return;
          setLogin((prev) =>
            prev?.sessionId === sessionId ? null : prev,
          );
        }, 1500);
      } else {
        updateLogin((prev) => ({
          ...prev,
          busy: false,
          error: payload.error,
          status: "失敗",
        }));
      }
    });
    es.onerror = () => {
      if (!isCurrent()) return;
      // EventSource may emit transient errors while reconnecting; only fail
      // once the connection is closed for good.
      if (es.readyState !== EventSource.CLOSED) return;
      closed = true;
      es.close();
      updateLogin((prev) => ({
        ...prev,
        busy: false,
        error: "ログインイベント接続に失敗しました",
        status: "失敗",
      }));
    };
    return () => {
      closed = true;
      if (finishTimer !== undefined) window.clearTimeout(finishTimer);
      es.close();
    };
  }, [login?.sessionId, login?.providerId, onChanged, refreshAccounts]);

  async function stopLogin() {
    const activeLogin = login;
    // Always invalidate in-flight beginLogin so a late sessionId cannot revive UI.
    ++loginGenerationRef.current;
    setLogin(null);
    if (!activeLogin?.sessionId) return;
    try {
      await fetch(
        apiUrl(
          `/api/providers/${encodeURIComponent(activeLogin.providerId)}/login/answer?sessionId=${encodeURIComponent(activeLogin.sessionId)}`,
        ),
        {
          method: "DELETE",
        },
      );
    } catch {
      /* ignore */
    }
  }

  async function beginLogin(
    provider: Pick<ProviderAuthDto, "id" | "name">,
    authType: "api_key" | "oauth",
    accountId?: string | null,
  ) {
    const generation = ++loginGenerationRef.current;
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
      if (loginGenerationRef.current !== generation) {
        // Cancelled while POST was in flight — tear down the orphan server session.
        try {
          await fetch(
            apiUrl(
              `/api/providers/${encodeURIComponent(provider.id)}/login/answer?sessionId=${encodeURIComponent(result.sessionId)}`,
            ),
            { method: "DELETE" },
          );
        } catch {
          /* ignore */
        }
        return;
      }
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
        loginGenerationRef.current === generation && prev
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
    const activeLogin = login;
    const prompt = activeLogin?.prompt;
    if (!prompt) return;
    const generation = loginGenerationRef.current;
    setLogin((prev) =>
      loginGenerationRef.current === generation &&
      prev?.sessionId === activeLogin.sessionId &&
      prev.prompt?.id === prompt.id
        ? { ...prev, busy: true, error: null }
        : prev,
    );
    try {
      if (!activeLogin.sessionId) {
        throw new Error("ログインセッションがありません");
      }
      await sendJson(
        `/api/providers/${encodeURIComponent(activeLogin.providerId)}/login/answer`,
        {
          promptId: prompt.id,
          value,
          sessionId: activeLogin.sessionId,
        },
      );
      setLogin((prev) =>
        loginGenerationRef.current === generation &&
        prev?.sessionId === activeLogin.sessionId &&
        prev.prompt?.id === prompt.id
          ? { ...prev, prompt: null, input: "", busy: false, status: "続行中…" }
          : prev,
      );
    } catch (error) {
      setLogin((prev) =>
        loginGenerationRef.current === generation &&
        prev?.sessionId === activeLogin.sessionId &&
        prev.prompt?.id === prompt.id
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

  async function toggleAccount(account: AccountRecord) {
    setAccountBusy(true);
    try {
      await sendJson(
        `/api/accounts/${encodeURIComponent(account.id)}`,
        { enabled: account.enabled === false },
        "PATCH",
      );
      await refreshAccounts();
      onChanged();
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
      // Cancel an in-flight login for this account before DELETE so the auth
      // session cannot keep writing into a removed account.
      if (login?.accountId === account.id) await stopLogin();
      await sendJson(
        `/api/accounts/${encodeURIComponent(account.id)}`,
        {},
        "DELETE",
      );
      await refreshAccounts();
      onChanged();
    } catch (error) {
      window.alert(error instanceof ApiError ? error.message : String(error));
    } finally {
      setAccountBusy(false);
    }
  }

  async function reorderProviderAccounts(
    providerId: AccountProviderId,
    fromIndex: number,
    toIndex: number,
  ) {
    if (accountOrderBusy || accountBusy || !accounts || fromIndex === toIndex) {
      return;
    }
    const providerAccounts = accounts.filter(
      (account) =>
        Array.isArray(account.providers) && account.providers.includes(providerId),
    );
    if (
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= providerAccounts.length ||
      toIndex >= providerAccounts.length
    ) {
      return;
    }

    const nextProviderAccounts = [...providerAccounts];
    const [moved] = nextProviderAccounts.splice(fromIndex, 1);
    if (!moved) return;
    nextProviderAccounts.splice(toIndex, 0, moved);

    const providerAccountIds = new Set(providerAccounts.map((account) => account.id));
    let providerIndex = 0;
    const nextAccounts = accounts.map((account) =>
      providerAccountIds.has(account.id)
        ? nextProviderAccounts[providerIndex++]!
        : account,
    );

    setAccounts(nextAccounts);
    setDraggingAccountId(null);
    setDragOverAccountId(null);
    setAccountOrderBusy(true);
    setAccountOrderError(null);
    try {
      const result = await sendJson<{ accounts: AccountRecord[] }>(
        "/api/accounts",
        { accountOrder: nextAccounts.map((account) => account.id) },
        "PATCH",
      );
      setAccounts(result.accounts);
      setReorderAnnouncement(`${moved.label}を${toIndex + 1}番目へ移動しました`);
      onChanged();
    } catch (error) {
      setAccountOrderError(
        error instanceof ApiError ? error.message : String(error),
      );
      await refreshAccounts();
    } finally {
      setAccountOrderBusy(false);
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
    if (!cookieInput.trim() || cookieBusy || login) return;
    const route = COOKIE_UI[providerId as AccountProviderId]?.route;
    if (!route) return;
    const key = cookieKey(providerId, accountId);
    setCookieBusy(key);
    setCookieErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    try {
      await sendJson(
        `/api/accounts/${encodeURIComponent(accountId)}/${route}`,
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
    const cookieUi = COOKIE_UI[providerId as AccountProviderId];
    if (!cookieUi) return;
    const name = cookieUi.providerName;
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
        `/api/accounts/${encodeURIComponent(accountId)}/${cookieUi.route}`,
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

  /** API キー口座の基準残高（購入額）を保存し、残高から使用％を算出できるようにする。 */
  async function saveBaseline(accountId: string, raw: string) {
    const key = cookieKey("anthropic", accountId);
    const value = Number(raw.trim());
    if (!raw.trim() || !Number.isFinite(value) || value <= 0) {
      setBaselineErrors((current) => ({
        ...current,
        [key]: "0 より大きい数値を入力してください",
      }));
      return;
    }
    if (baselineBusy) return;
    setBaselineBusy(key);
    setBaselineErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    try {
      await sendJson(
        `/api/accounts/${encodeURIComponent(accountId)}/anthropic-baseline`,
        { baselineUsd: value },
      );
      setBaselineInputs((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      await refreshAccounts();
      onChanged();
    } catch (error) {
      setBaselineErrors((current) => ({
        ...current,
        [key]: error instanceof ApiError ? error.message : String(error),
      }));
    } finally {
      setBaselineBusy(null);
    }
  }

  async function clearBaseline(accountId: string) {
    const key = cookieKey("anthropic", accountId);
    if (baselineBusy) return;
    setBaselineBusy(key);
    setBaselineErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    try {
      await sendJson(
        `/api/accounts/${encodeURIComponent(accountId)}/anthropic-baseline`,
        {},
        "DELETE",
      );
      setBaselineInputs((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      await refreshAccounts();
      onChanged();
    } catch (error) {
      setBaselineErrors((current) => ({
        ...current,
        [key]: error instanceof ApiError ? error.message : String(error),
      }));
    } finally {
      setBaselineBusy(null);
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
    const activeProviderAccountCount = providerAccounts.filter(
      (account) => account.enabled !== false,
    ).length;
    const isCreating = creatingFor === providerId;
    // 利用可能なログイン方式をすべて出す（Anthropic はサブスクと API キーの両方）。
    const accountAuthTypes: ("api_key" | "oauth")[] = [];
    if (provider.oauthAvailable === true || provider.methods?.includes("oauth")) {
      accountAuthTypes.push("oauth");
    }
    if (provider.methods?.includes("api_key")) accountAuthTypes.push("api_key");
    const cookieUi = COOKIE_UI[providerId];
    const mode = provider.accountRoutingMode ?? "separate";
    const savingMode = routingBusy === providerId;
    const modeDisabled = Boolean(login) || accountBusy || Boolean(routingBusy);

    return (
      <section
        aria-label={`${provider.name} の追加アカウント`}
        aria-busy={savingMode || accountOrderBusy || undefined}
        className="mt-2"
      >
        <div
          className="flex flex-wrap items-center justify-between gap-2"
          aria-busy={savingMode || undefined}
        >
          <div className="flex items-center gap-3">
            <h3 className="text-xs font-semibold text-muted">アカウント</h3>
            {activeProviderAccountCount >= 2 && (
              <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-muted">
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
            )}
          </div>
          {!isCreating && (
            <Button
              size="sm"
              variant="outline"
              aria-label="アカウントを追加"
              disabled={Boolean(login) || accountBusy}
              onClick={() => {
                setCreatingFor(providerId);
                setNewLabel("");
              }}
            >
              追加
            </Button>
          )}
        </div>
        {routingErrors[providerId] && (
          <p className="mt-1 text-xs text-danger" role="alert">
            {routingErrors[providerId]}
          </p>
        )}
        {accountsError && (
          <p role="alert" className="mt-2 text-xs text-danger">{accountsError}</p>
        )}
        {accountOrderError && (
          <p role="alert" className="mt-2 text-xs text-danger">{accountOrderError}</p>
        )}
        {accounts === null ? (
          <p className="mt-2 text-xs text-muted">読み込み中…</p>
        ) : (
          <>
            {providerAccounts.length > 0 && (
              <ul className="mt-2 space-y-2 rounded-xl bg-surface-2 p-2">
                {providerAccounts.map((account, accountIndex) => {
                  const cookieConfigured =
                    cookieStatuses[cookieKey(providerId, account.id)] === true;
                  const piAuthenticated =
                    authStatuses[account.id]?.includes(providerId) === true;
                  const authenticated =
                    piAuthenticated ||
                    (providerId === "opencode-go" && cookieConfigured);
                  const currentCookieKey = cookieKey(providerId, account.id);
                  const cookieEditing = cookieEditingKey === currentCookieKey;
                  const cookieAccountBusy = cookieBusy === currentCookieKey;
                  const baselineStored = creditBaselines[currentCookieKey] ?? null;
                  const baselineInput =
                    baselineInputs[currentCookieKey] ??
                    (baselineStored === null ? "" : String(baselineStored));
                  const baselineAccountBusy = baselineBusy === currentCookieKey;
                  // Anthropic の Console cookie は API キー口座専用。
                  // サブスク（OAuth）口座は subscription の枠/クレジットを返すので不要。
                  const showCookieUi =
                    cookieUi !== undefined &&
                    !(
                      providerId === "anthropic" &&
                      credentialKinds[currentCookieKey] === "oauth"
                    );
                  const usage = findProviderUsage(
                    codexBarUsage,
                    providerId,
                    account.id,
                  );
                  return (
                    <li
                      key={account.id}
                      draggable={
                        providerAccounts.length > 1 &&
                        !accountOrderBusy &&
                        !accountBusy
                      }
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = "move";
                        setDraggingAccountId(account.id);
                      }}
                      onDragOver={(event) => {
                        if (
                          !draggingAccountId ||
                          draggingAccountId === account.id ||
                          accountOrderBusy
                        ) {
                          return;
                        }
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "move";
                        setDragOverAccountId(account.id);
                      }}
                      onDragLeave={() => {
                        if (dragOverAccountId === account.id) {
                          setDragOverAccountId(null);
                        }
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        if (!draggingAccountId) return;
                        const fromIndex = providerAccounts.findIndex(
                          (item) => item.id === draggingAccountId,
                        );
                        void reorderProviderAccounts(
                          providerId,
                          fromIndex,
                          accountIndex,
                        );
                      }}
                      onDragEnd={() => {
                        setDraggingAccountId(null);
                        setDragOverAccountId(null);
                      }}
                      className={cx(
                        "rounded-xl border border-border bg-surface px-3 py-2 shadow-sm",
                        draggingAccountId === account.id && "opacity-50",
                        dragOverAccountId === account.id &&
                          draggingAccountId !== account.id &&
                          "ring-1 ring-inset ring-accent",
                      )}
                    >
                      <div className="flex flex-col gap-1">
                        {editingAccountId === account.id ? (
                          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
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
                          <>
                            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                              {providerAccounts.length > 1 && (
                                <GripVertical
                                  aria-hidden="true"
                                  className="h-4 w-4 shrink-0 cursor-grab text-muted active:cursor-grabbing"
                                />
                              )}
                              <span
                                className="min-w-0 break-all text-sm font-medium"
                                title={account.label}
                              >
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
                              {account.enabled === false && (
                                <Badge tone="warning">一時停止中</Badge>
                              )}
                              <Switch
                                checked={account.enabled !== false}
                                label={`${account.label}を使用`}
                                title={
                                  account.enabled === false
                                    ? "アカウントを再開"
                                    : "アカウントを一時停止"
                                }
                                busy={accountBusy}
                                disabled={Boolean(login)}
                                onChange={() => void toggleAccount(account)}
                              />
                            </div>
                            <div className="flex flex-wrap gap-1">
                              {accountAuthTypes.map((authType) => (
                                <Button
                                  key={authType}
                                  size="sm"
                                  disabled={Boolean(login) || accountBusy}
                                  onClick={() =>
                                    void beginLogin(
                                      provider,
                                      authType,
                                      account.id,
                                    )
                                  }
                                >
                                  {accountLoginLabel(
                                    authType,
                                    accountAuthTypes.length,
                                    authenticated,
                                  )}
                                </Button>
                              ))}
                              {piAuthenticated && (
                                <Button
                                  size="sm"
                                  variant="outline"
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
                                variant="outline"
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
                                variant="danger"
                                disabled={accountBusy || login?.accountId === account.id}
                                onClick={() => void removeAccount(account)}
                              >
                                削除
                              </Button>
                              {providerAccounts.length > 1 && (
                                <div className="flex items-center gap-1">
                                  <button
                                    type="button"
                                    aria-label={`${account.label} を上へ移動`}
                                    title="上へ"
                                    disabled={
                                      accountOrderBusy ||
                                      accountBusy ||
                                      accountIndex === 0
                                    }
                                    onClick={() =>
                                      void reorderProviderAccounts(
                                        providerId,
                                        accountIndex,
                                        accountIndex - 1,
                                      )
                                    }
                                    className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text disabled:opacity-30 sm:h-7 sm:w-7"
                                  >
                                    <ChevronUp aria-hidden="true" className="h-4 w-4" />
                                  </button>
                                  <button
                                    type="button"
                                    aria-label={`${account.label} を下へ移動`}
                                    title="下へ"
                                    disabled={
                                      accountOrderBusy ||
                                      accountBusy ||
                                      accountIndex === providerAccounts.length - 1
                                    }
                                    onClick={() =>
                                      void reorderProviderAccounts(
                                        providerId,
                                        accountIndex,
                                        accountIndex + 1,
                                      )
                                    }
                                    className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text disabled:opacity-30 sm:h-7 sm:w-7"
                                  >
                                    <ChevronDown aria-hidden="true" className="h-4 w-4" />
                                  </button>
                                </div>
                              )}
                            </div>
                          </>
                        )}
                      </div>
                      {usage && (usage.usedPercent !== null || !usage.credits) && (
                        <UsageBar percent={usage.usedPercent} />
                      )}
                      {usage?.credits && <CreditsLine credits={usage.credits} />}
                      {usage && (
                        <ResetCreditsControl
                          provider={usage}
                          busy={resetBusyKey === resetCreditKey(usage)}
                          status={
                            resetStatusByKey[resetCreditKey(usage)] ?? null
                          }
                          onRedeem={redeemResetCredit}
                        />
                      )}
                      {showCookieUi && cookieUi && (
                        <div className="mt-2 border-t border-border pt-2">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <p className="text-xs font-semibold text-muted">
                                {cookieUi.title}
                              </p>
                              <p
                                className="mt-0.5 text-xs text-muted"
                                role="status"
                              >
                                {cookieConfigured
                                  ? "このアカウントの cookie を登録済み"
                                  : cookieUi.missingHint}
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
                                {cookieUi.domain}{" "}
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
                                    Boolean(login) ||
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
                          {providerId === "anthropic" && (
                            <form
                              className="mt-2 flex flex-col gap-2 border-t border-border pt-2"
                              onSubmit={(event) => {
                                event.preventDefault();
                                void saveBaseline(account.id, baselineInput);
                              }}
                            >
                              <label
                                htmlFor={`${providerId}-baseline-${account.id}`}
                                className="text-xs text-muted"
                              >
                                API 基準残高（購入額 USD）― 残高から使用％を算出
                              </label>
                              <div className="flex flex-wrap items-center gap-2">
                                <input
                                  id={`${providerId}-baseline-${account.id}`}
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  inputMode="decimal"
                                  value={baselineInput}
                                  onChange={(event) => {
                                    // event を updater 内で読むと DOM 値が戻った後の値になりうるため、先に取り出す。
                                    const next = event.target.value;
                                    setBaselineInputs((current) => ({
                                      ...current,
                                      [currentCookieKey]: next,
                                    }));
                                  }}
                                  placeholder="例: 100"
                                  spellCheck={false}
                                  autoComplete="off"
                                  disabled={baselineAccountBusy}
                                  className="w-28 rounded-xl border border-border bg-surface px-3 py-1.5 text-sm outline-none focus:border-accent"
                                  aria-describedby={`${providerId}-baseline-help-${account.id}`}
                                />
                                <Button
                                  type="submit"
                                  size="sm"
                                  busy={baselineAccountBusy}
                                  disabled={
                                    baselineAccountBusy || !baselineInput.trim()
                                  }
                                  aria-label={`${account.label} の基準残高を保存`}
                                >
                                  保存
                                </Button>
                                {baselineStored !== null && (
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    disabled={baselineAccountBusy}
                                    onClick={() => void clearBaseline(account.id)}
                                    aria-label={`${account.label} の基準残高を解除`}
                                  >
                                    解除
                                  </Button>
                                )}
                                <span
                                  id={`${providerId}-baseline-help-${account.id}`}
                                  className="text-xs text-muted"
                                >
                                  {baselineStored === null
                                    ? "未設定（残高のみ表示）"
                                    : `基準 ${formatCreditAmount(baselineStored)}`}
                                </span>
                              </div>
                              {baselineErrors[currentCookieKey] && (
                                <p className="text-xs text-danger" role="alert">
                                  {baselineErrors[currentCookieKey]}
                                </p>
                              )}
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

  const enabledProviderRanks = new Map(
    enabledProviderOrder.map((providerId, index) => [providerId, index]),
  );
  const visibleProviders = providers.filter(
    (provider) =>
      provider.authenticated ||
      provider.highlighted === true ||
      provider.baseUrl != null,
  );
  const orderedProviders = [...visibleProviders].sort((a, b) => {
    const aRank = enabledProviderRanks.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const bRank = enabledProviderRanks.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    return (
      aRank - bRank ||
      Number(b.authenticated) - Number(a.authenticated)
    );
  });

  return (
    <div className="space-y-4">
      <p role="status" aria-live="polite" className="sr-only">
        {reorderAnnouncement}
      </p>
      <div>
        <h3 className="mb-2 text-sm font-semibold">プロバイダー</h3>
        <details className="mb-3 text-xs text-muted">
          <summary className="cursor-pointer select-none">対応・設定方法</summary>
          <p className="mt-2">
            Claude Pro/Max（Anthropic）、ChatGPT Plus/Pro（OpenAI
            Codex）、Cursor、OpenCode、Command Code（Go プラン可）、および Ollama
            Cloud / OpenRouter / OrcaRouter に対応しています。TypeSafe は System One API の
            API キーを登録できます（チャットモデルとしてはモデル一覧に出ません）。
            TypeSafe の実残高は TypeSafe Console（console.typesafe.ai）の cookie を
            登録すると表示できます。cookie未登録・失効時は Jev 呼び出しから積算した
            推定利用額を表示します。マルチアカウント対応プロバイダーはアカウントごとに管理します。共有プロバイダーでは環境変数または
            ~/.pi/agent/auth.json を引き続き使えます。Command Code は{" "}
            <span className="font-mono">COMMANDCODE_API_KEY</span> /{" "}
            <span className="font-mono">~/.commandcode/auth.json</span>、Ollama
            Cloud は <span className="font-mono">OLLAMA_API_KEY</span>{" "}
            でも設定できます。OrcaRouter は <span className="font-mono">ORCAROUTER_API_KEY</span>{" "}
            でも設定できます。Ollama Cloud はアカウントごとに cookie
            も登録できます。OpenCode Go の利用量にもアカウント別 cookie
            を登録できます。Anthropic はアカウントごとにサブスク（OAuth）と API
            キーのどちらでも登録でき、API キーアカウントのクレジット残高は
            Anthropic Console（platform.claude.com）の cookie
            を登録すると表示されます。Ollama Cloud / LeafCodeCloud の API URL
            は各行で変更でき、次回起動から反映されます。
          </p>
          <p className="mt-2">
            {REMOTE_OAUTH_HINT}
          </p>
        </details>
        <ul className="grid items-stretch gap-3 lg:grid-cols-2">
          {orderedProviders.length === 0 && (
            <li className="text-sm text-muted lg:col-span-2">プロバイダーが見つかりません</li>
          )}
          {orderedProviders.map((provider) => {
            const usage = findProviderUsage(codexBarUsage, provider.id);
            const resetKey = usage ? resetCreditKey(usage) : null;
            return (
              <ProviderRow
                key={provider.id}
                provider={provider}
                disabled={Boolean(login)}
                onChanged={onChanged}
                usage={usage}
                resetBusy={resetKey === resetBusyKey}
                resetStatus={resetKey ? resetStatusByKey[resetKey] ?? null : null}
                onRedeemReset={redeemResetCredit}
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
                cookieControls={
                  provider.id === "typesafe" ? (
                    <TypeSafeCookieControl
                      disabled={Boolean(login)}
                      onChanged={() => {
                        onChanged();
                        void loadCodexBarUsage(true)
                          .then(setCodexBarUsage)
                          .catch(() => undefined);
                      }}
                    />
                  ) : undefined
                }
              />
            );
          })}
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
          {login.authType === "oauth" && (
            <p className="mt-2 text-xs text-muted">{REMOTE_OAUTH_HINT}</p>
          )}
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
            <p role="alert" className="mt-2 text-sm text-danger">{login.error}</p>
          )}
        </div>
      )}
    </div>
  );
});

function BaseUrlEditor({
  providerId,
  providerName,
  value,
  onSave,
}: {
  providerId: string;
  providerName: string;
  value: string;
  onSave: () => void;
}) {
  const [input, setInput] = useState(value);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const dirty = input.trim() !== value.trim();

  useEffect(() => {
    setInput(value);
  }, [value]);

  async function save() {
    const next = input.trim();
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await sendJson(
        `/api/providers/${encodeURIComponent(providerId)}/base-url`,
        { baseUrl: next },
        "PUT",
      );
      setMessage("保存しました（次回起動から反映）");
      onSave();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 border-t border-border pt-2">
      <label
        htmlFor={`base-url-${providerId}`}
        className="block text-xs text-muted"
      >
        API URL
      </label>
      <div className="mt-1 flex gap-2">
        <input
          id={`base-url-${providerId}`}
          type="text"
          spellCheck={false}
          autoComplete="off"
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
            if (message) setMessage(null);
          }}
          placeholder={value}
          aria-label={`${providerName} の API URL`}
          className="min-w-0 flex-1 rounded-xl border border-border bg-surface px-3 py-1.5 text-xs font-mono outline-none focus:border-accent"
        />
        <Button
          size="sm"
          busy={busy}
          disabled={!dirty}
          onClick={() => void save()}
        >
          保存
        </Button>
      </div>
      {message && (
        <p
          className={`mt-1 text-xs ${/失敗|エラー|不正|指定してください/.test(message) ? "text-danger" : "text-success"}`}
          role="status"
        >
          {message}
        </p>
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
  cookieControls,
  accountControls,
  usage,
  resetBusy = false,
  resetStatus = null,
  onRedeemReset,
  onChanged,
}: {
  provider: ProviderAuthDto;
  disabled?: boolean;
  onOAuth?: () => void;
  onApiKey?: () => void;
  onLogout?: () => void;
  accountControls?: ReactNode;
  cookieControls?: ReactNode;
  usage?: CodexBarProvider | null;
  resetBusy?: boolean;
  resetStatus?: string | null;
  onRedeemReset?: (provider: CodexBarProvider) => void;
  onChanged: () => void;
}) {
  const accountManaged = isAccountProviderId(provider.id);
  const badge = accountManaged ? null : authBadge(provider);
  const hint = accountManaged ? null : sourceHint(provider);
  return (
    <li className="rounded-xl border border-border bg-surface px-2 py-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <ProviderIcon providerID={provider.id} size={16} />
            <span className="text-sm font-medium">{provider.name}</span>
            <span className="font-mono text-xs text-muted">{provider.id}</span>
            {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
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
      {usage && <UsageBar percent={usage.usedPercent} />}
      {usage && onRedeemReset && (
        <ResetCreditsControl
          provider={usage}
          busy={resetBusy}
          status={resetStatus}
          onRedeem={onRedeemReset}
        />
      )}
      {accountControls}
      {cookieControls}
      {provider.baseUrl != null && (
        <BaseUrlEditor
          providerId={provider.id}
          providerName={provider.name}
          value={provider.baseUrl}
          onSave={onChanged}
        />
      )}
    </li>
  );
}

/** 共有 TypeSafe プロバイダーの実残高用 Console cookie。本文は一切再表示しない。 */
function TypeSafeCookieControl({
  disabled,
  onChanged,
}: {
  disabled: boolean;
  onChanged: () => void;
}) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<number | null>(null);
  const [baselineInput, setBaselineInput] = useState("");
  const baselineInputDirtyRef = useRef(false);
  const [baselineBusy, setBaselineBusy] = useState(false);
  const [baselineError, setBaselineError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [cookieResult, baselineResult] = await Promise.allSettled([
      getJson<{ configured?: boolean }>("/api/typesafe-cookie"),
      getJson<{ baselineUsd?: number | null }>("/api/typesafe-baseline"),
    ]);
    if (cookieResult.status === "fulfilled") {
      setConfigured(cookieResult.value.configured === true);
      setError(null);
    } else {
      setConfigured(null);
      setError(
        cookieResult.reason instanceof ApiError
          ? cookieResult.reason.message
          : "TypeSafe cookie の状態を確認できません",
      );
    }
    if (baselineResult.status === "fulfilled") {
      const baselineUsd =
        typeof baselineResult.value.baselineUsd === "number" &&
        baselineResult.value.baselineUsd > 0
          ? baselineResult.value.baselineUsd
          : null;
      setBaseline(baselineUsd);
      // 非同期の初期読込が、ユーザーが既に入力した値を上書きしてはいけない。
      if (!baselineInputDirtyRef.current) {
        setBaselineInput(baselineUsd === null ? "" : String(baselineUsd));
      }
      setBaselineError(null);
    } else {
      setBaselineError(
        baselineResult.reason instanceof ApiError
          ? baselineResult.reason.message
          : "TypeSafe 基準残高の状態を確認できません",
      );
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function save() {
    if (!input.trim() || busy || disabled) return;
    setBusy(true);
    setError(null);
    try {
      await sendJson("/api/typesafe-cookie", { cookies: input });
      setInput("");
      setEditing(false);
      setConfigured(true);
      onChanged();
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : "cookie を保存できません",
      );
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (
      busy ||
      disabled ||
      !window.confirm("TypeSafe Console cookie を削除しますか？")
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await sendJson("/api/typesafe-cookie", {}, "DELETE");
      setEditing(false);
      setInput("");
      setConfigured(false);
      onChanged();
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : "cookie を削除できません",
      );
    } finally {
      setBusy(false);
    }
  }

  async function saveBaseline() {
    const baselineUsd = Number(baselineInput.trim());
    if (!Number.isFinite(baselineUsd) || baselineUsd <= 0) {
      setBaselineError("0 より大きい数値を入力してください");
      return;
    }
    setBaselineBusy(true);
    setBaselineError(null);
    try {
      await sendJson("/api/typesafe-baseline", { baselineUsd });
      baselineInputDirtyRef.current = false;
      setBaseline(baselineUsd);
      onChanged();
    } catch (cause) {
      setBaselineError(
        cause instanceof ApiError ? cause.message : "基準残高を保存できません",
      );
    } finally {
      setBaselineBusy(false);
    }
  }

  async function clearBaseline() {
    setBaselineBusy(true);
    setBaselineError(null);
    try {
      await sendJson("/api/typesafe-baseline", {}, "DELETE");
      baselineInputDirtyRef.current = false;
      setBaseline(null);
      setBaselineInput("");
      onChanged();
    } catch (cause) {
      setBaselineError(
        cause instanceof ApiError ? cause.message : "基準残高を解除できません",
      );
    } finally {
      setBaselineBusy(false);
    }
  }

  return (
    <div className="mt-2 border-t border-border pt-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs font-semibold text-muted">TypeSafe Console cookie</p>
          <p className="mt-0.5 text-xs text-muted" role="status">
            {configured === null
              ? "cookie の状態を確認中…"
              : configured
                ? "実残高を表示できます"
                : "実残高表示には cookie が必要です"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Badge tone={configured ? "success" : "neutral"}>
            {configured ? "登録済み" : "未登録"}
          </Badge>
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled || busy}
            onClick={() => {
              setEditing(true);
              setInput("");
              setError(null);
            }}
          >
            {configured ? "更新" : "登録"}
          </Button>
          {configured && (
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled || busy}
              onClick={() => void remove()}
            >
              削除
            </Button>
          )}
        </div>
      </div>
      {editing && (
        <form
          className="mt-2 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label htmlFor="typesafe-console-cookie" className="text-xs text-muted">
            Netscape 形式の cookie
          </label>
          <textarea
            id="typesafe-console-cookie"
            rows={5}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="# Netscape HTTP Cookie File"
            spellCheck={false}
            autoComplete="off"
            className="w-full resize-y rounded-xl border border-border bg-surface px-3 py-2 font-mono text-xs outline-none focus:border-accent"
            aria-describedby="typesafe-console-cookie-help"
            disabled={busy || disabled}
            autoFocus
          />
          <p id="typesafe-console-cookie-help" className="text-xs text-muted">
            console.typesafe.ai の Netscape cookie または Cookie ヘッダー（session_id、organization_id、session を含む）を貼り付けてください。保存後、本文は画面に表示しません。
          </p>
          {error && (
            <p className="text-xs text-danger" role="alert">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" size="sm" busy={busy} disabled={disabled || busy || !input.trim()}>
              保存
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setInput("");
                setError(null);
              }}
            >
              キャンセル
            </Button>
          </div>
        </form>
      )}
      {!editing && error && (
        <p className="mt-2 text-xs text-danger" role="alert">
          {error}
        </p>
      )}
      <form
        className="mt-2 flex flex-col gap-2 border-t border-border pt-2"
        onSubmit={(event) => {
          event.preventDefault();
          void saveBaseline();
        }}
      >
        <label htmlFor="typesafe-credit-baseline" className="text-xs text-muted">
          基準残高（USD）― 残高から使用％を算出
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <input
            id="typesafe-credit-baseline"
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            value={baselineInput}
            onChange={(event) => {
              baselineInputDirtyRef.current = true;
              setBaselineInput(event.target.value);
            }}
            placeholder="例: 5"
            spellCheck={false}
            autoComplete="off"
            disabled={disabled || baselineBusy}
            className="w-28 rounded-xl border border-border bg-surface px-3 py-1.5 text-sm outline-none focus:border-accent"
          />
          <Button
            type="submit"
            size="sm"
            busy={baselineBusy}
            disabled={disabled || baselineBusy || !baselineInput.trim()}
          >
            保存
          </Button>
          {baseline !== null && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled || baselineBusy}
              onClick={() => void clearBaseline()}
            >
              解除
            </Button>
          )}
        </div>
        <p className="text-xs text-muted">
          {baseline === null
            ? "実残高を取得できると使用％を表示します"
            : `基準残高 ${formatCreditAmount(baseline)}。使用率は表示専用です`}
        </p>
        {baselineError && (
          <p className="text-xs text-danger" role="alert">
            {baselineError}
          </p>
        )}
      </form>
    </div>
  );
}
