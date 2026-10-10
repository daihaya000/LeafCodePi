/** Public HTTP/UI declarations. No owner module or SDK dependency. */

import type { ThinkingLevel } from "./types";

export type AccountProviderId =
  | "openai"
  | "openai-codex"
  | "anthropic"
  | "ollama-cloud"
  | "openrouter"
  | "commandcode"
  | "cursor"
  | "opencode"
  | "opencode-go"
  | "orcarouter"
  | "opendesign";

export type AccountRecord = {
  id: string;
  label: string;
  /** モデル選択・ルーティングで使用するアカウントか。 */
  enabled: boolean;
  /** Expiring Codex reset credits: default ON; explicit false disables for this account. */
  codexResetAutoConsume?: boolean;
  /** Claude subscription reset grants: default ON; requires account claude.ai cookies. */
  anthropicResetAutoConsume?: boolean;
  /** このアカウントでログイン可能なプロバイダー（作成時に確定、変更不可）。 */
  providers: AccountProviderId[];
  note?: string;
  createdAt: string;
  updatedAt: string;
};

export type AccountCredentialKind = "oauth" | "api_key";

export type AuthTypeDto = "api_key" | "oauth";

export type LoginPromptDto =
  | { type: "text"; message: string; placeholder?: string }
  | { type: "secret"; message: string; placeholder?: string }
  | {
      type: "select";
      message: string;
      options: { id: string; label: string; description?: string }[];
    }
  | { type: "manual_code"; message: string; placeholder?: string };

export type LoginNotifyDto =
  | { type: "info"; message: string; links?: { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string; callbackUrl?: string }
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { type: "progress"; message: string };

export type LoginSessionEvent =
  | {
      type: "started";
      providerId: string;
      authType: AuthTypeDto;
      accountId?: string | null;
    }
  | { type: "notify"; event: LoginNotifyDto }
  | { type: "prompt"; id: string; prompt: LoginPromptDto }
  | { type: "done"; ok: true; warning?: string }
  | { type: "done"; ok: false; error: string };

export type AccountRoutingMode = "integrated" | "separate";

export type ProviderModelRow = {
  id: string;
  name: string;
  enabled: boolean;
  contextWindow?: number;
  thinkingLevels?: ThinkingLevel[];
  defaultThinkingLevel?: ThinkingLevel;
};

export type ProviderModelsRow = {
  id: string;
  name: string;
  enabled: boolean;
  models: ProviderModelRow[];
  /** 設定対象のログインアカウント。未指定は共有プロバイダ設定。 */
  accountId?: string;
  accountLabel?: string;
  /** 統合行に含まれるログインアカウント。 */
  accountIds?: string[];
};

export type TtsConfigDto = {
  enabled: boolean;
  voice: string;
  rate: number;
  url: string;
};

export type TtsHostCapabilities = {
  hostPlatform: NodeJS.Platform;
  sapiAvailable: boolean;
};

export type TtsSettingsDto = TtsConfigDto & TtsHostCapabilities;

export type SkillSource = "pi" | "bundled";

export type SkillScope = "code" | "bot";

export type SkillDto = {
  id: string;
  name: string;
  description?: string;
  /** Backward-compatible alias for the Code setting. */
  enabled: boolean;
  codeEnabled: boolean;
  botEnabled: boolean;
  filePath: string;
  source: SkillSource;
};

export type PushoverSettingsDto = {
  hasToken: boolean;
  hasUser: boolean;
  device: string;
  enabled: boolean;
  envManaged: { token: boolean; user: boolean; device: boolean };
};

export type PushoverSettingsPatch = { token?: string | null; user?: string | null; device?: string | null; enabled?: boolean };

export type TransferScope = "settings" | "credentials" | "all";

export type AuthEntries = Record<string, Record<string, unknown>>;

export type CookieName = "anthropic" | "opencode" | "ollama";

export type AccountBackup = {
  record: AccountRecord;
  auth: AuthEntries;
  cookies: Partial<Record<CookieName, string>>;
  openrouterManagementKey?: string;
  opencodeWorkspaceId?: string;
  peer?: PeerConfig;
};

export type CredentialBackup = {
  defaultAuth: AuthEntries;
  accounts: AccountBackup[];
  sharedCookies: Partial<Record<CookieName | "typesafe", string>>;
};

export type SettingsBackup = {
  format: "leafcode-pi-settings";
  version: 1;
  scope: TransferScope;
  exportedAt: string;
  settings?: Record<string, string | number>;
  credentials?: CredentialBackup;
};

export type TokenUsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  responses: number;
  startedAt: string | null;
};

export type TokenUsageEstimate = {
  /** Optional for compatibility with older API snapshots. */
  status?: "calibrating" | "ready" | "stale" | "expired" | "unsupported" | "invalid";
  /** Earlier of upstream freshness expiry and quota reset. */
  validUntil?: string | null;
  id: string;
  title: string;
  sampledTokens: number;
  sampledPercent: number;
  tokensPerPercent: number | null;
  estimatedRemainingTokens: number | null;
  /** Display-only sum of independent account capacities; otherwise rate × 100. */
  estimatedTotalTokens?: number | null;
};

export type ProviderTokenUsage = TokenUsageTotals & {
  windows: TokenUsageEstimate[];
};

export type PeerConfig = {
  version: 1;
  peerUrl: string;
  peerAccountId: string | null;
  providers: string[];
  token: string;
  createdAt: string;
};
