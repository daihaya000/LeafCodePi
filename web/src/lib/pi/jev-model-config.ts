import { createHash } from "node:crypto";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_JEV_MODEL_SETTINGS,
  JEV_MODEL_SETTING_KEY,
  jevModelEndpoint,
  normalizeJevModelSettings,
  type JevModelSettings,
  type JevModelSettingsDto,
} from "@/lib/jev-model-settings";
import { getSetting, setSetting } from "./web-settings";
import { registerTypeSafeProvider, TYPESAFE_PROVIDER_ID } from "./typesafe-provider";

export function readJevModelSettings(): JevModelSettings {
  const raw = getSetting(JEV_MODEL_SETTING_KEY);
  // Invalid saved configuration must not silently send state to another provider.
  return raw === null ? { ...DEFAULT_JEV_MODEL_SETTINGS } : normalizeJevModelSettings(JSON.parse(raw));
}

/** Bind custom credentials to the exact base URL, never reuse TypeSafe's key. */
export function jevCredentialProviderId(settings: JevModelSettings): string {
  if (settings.provider === "registered") throw new Error("既存プロバイダーの認証を使用してください");
  return settings.provider === "typesafe"
    ? TYPESAFE_PROVIDER_ID
    : `jev-compatible-${createHash("sha256").update(settings.compatibleBaseUrl).digest("hex")}`;
}

async function credentialRuntime(settings: JevModelSettings) {
  const runtime = await ModelRuntime.create({ refreshOnCreate: false });
  registerTypeSafeProvider(runtime);
  if (settings.compatibleBaseUrl) {
    runtime.registerProvider(jevCredentialProviderId({ ...settings, provider: "compatible" }), {
      name: "Jev Compatible",
      baseUrl: settings.compatibleBaseUrl,
      models: [],
    });
  }
  return runtime;
}

export async function readJevApiKey(settings: JevModelSettings): Promise<string | undefined> {
  const runtime = await credentialRuntime(settings);
  const key = (await runtime.getAuth(jevCredentialProviderId(settings)))?.auth.apiKey?.trim();
  if (!key && settings.provider === "typesafe") throw new Error("TypeSafe APIキーが設定されていません");
  return key || undefined;
}

export async function resolveJevModelConnection(settings: JevModelSettings): Promise<{
  baseUrl: string; model: string; apiKey?: string; headers?: Record<string, string>;
}> {
  if (settings.provider === "registered") {
    if (!settings.registeredModel) throw new Error("Jevモデルが選択されていません");
    const { resolveRegisteredJevModel } = await import("./harness");
    return resolveRegisteredJevModel(settings.registeredModel);
  }
  return { ...jevModelEndpoint(settings), apiKey: await readJevApiKey(settings) };
}

const LEGACY_JEV_CREDENTIAL_ID = /^jev-compatible-[0-9a-f]{64}$/;

/** Enumerate legacy-only credentials without exposing their keys or full endpoint paths. */
export async function listLegacyJevCredentials(): Promise<Array<{ providerId: string; label: string; active: boolean }>> {
  const runtime = await ModelRuntime.create({ refreshOnCreate: false });
  const settings = readJevModelSettings();
  const currentId = settings.compatibleBaseUrl
    ? jevCredentialProviderId({ ...settings, provider: "compatible" }) : null;
  return (await runtime.listCredentials())
    .filter(({ providerId }) => LEGACY_JEV_CREDENTIAL_ID.test(providerId))
    .map(({ providerId }) => ({
      providerId,
      label: providerId === currentId ? new URL(settings.compatibleBaseUrl).host : `旧接続先 ${providerId.slice(-8)}`,
      active: settings.provider === "compatible" && providerId === currentId,
    }));
}

export async function deleteLegacyJevCredential(providerId: string): Promise<void> {
  if (!LEGACY_JEV_CREDENTIAL_ID.test(providerId)) throw new Error("旧Jev互換キーの指定が不正です");
  const runtime = await ModelRuntime.create({ refreshOnCreate: false });
  if (!(await runtime.listCredentials()).some((credential) => credential.providerId === providerId)) {
    throw new Error("旧Jev互換キーが見つかりません");
  }
  await runtime.logout(providerId);
}

export async function getJevModelSettingsDto(): Promise<JevModelSettingsDto> {
  const settings = readJevModelSettings();
  const runtime = await credentialRuntime(settings);
  return {
    settings,
    hasApiKey: {
      typesafe: Boolean(await runtime.checkAuth(TYPESAFE_PROVIDER_ID)),
      compatible: Boolean(settings.compatibleBaseUrl) && Boolean(await runtime.checkAuth(
        jevCredentialProviderId({ ...settings, provider: "compatible" }),
      )),
    },
  };
}

/** Undefined keeps a key; null removes it; a string replaces it. Never echo it. */
export async function saveJevModelSettings(settings: JevModelSettings, apiKey?: string | null): Promise<void> {
  if (apiKey !== undefined) {
    if (settings.provider === "registered") throw new Error("既存プロバイダーの認証はプロバイダー接続から変更してください");
    const runtime = await credentialRuntime(settings);
    const providerId = jevCredentialProviderId(settings);
    if (apiKey === null) await runtime.logout(providerId);
    else await runtime.login(providerId, "api_key", {
      prompt: async () => apiKey,
      notify: () => {},
    });
  }
  setSetting(JEV_MODEL_SETTING_KEY, JSON.stringify(settings));
}
