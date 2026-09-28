import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getSetting, setSetting } from "@/lib/pi/web-settings";

const TOKEN_PROVIDER = "leafcode-pushover-token";
const USER_PROVIDER = "leafcode-pushover-user";
const DEVICE_SETTING = "pushover-device";

export type PushoverCredentials = { token?: string; user?: string; device?: string };
export type PushoverSettingsDto = {
  hasToken: boolean;
  hasUser: boolean;
  device: string;
  envManaged: { token: boolean; user: boolean; device: boolean };
};
export type PushoverSettingsPatch = { token?: string | null; user?: string | null; device?: string | null };

export class PushoverEnvManagedError extends Error {}

async function credentialRuntime(): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({ refreshOnCreate: false });
  for (const [id, name] of [[TOKEN_PROVIDER, "Pushover Token"], [USER_PROVIDER, "Pushover User Key"]]) {
    runtime.registerProvider(id, { name, baseUrl: "https://api.pushover.net", models: [] });
  }
  return runtime;
}

async function storedKey(runtime: ModelRuntime, provider: string): Promise<string | undefined> {
  return (await runtime.getAuth(provider))?.auth.apiKey?.trim() || undefined;
}

function envValue(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

/** SDK auth storage keeps secrets in the Pi credential file, never in WebUI settings. */
export async function readPushoverCredentials(): Promise<PushoverCredentials> {
  const envToken = envValue("LEAFCODE_PI_PUSHOVER_TOKEN");
  const envUser = envValue("LEAFCODE_PI_PUSHOVER_USER");
  const runtime = !envToken || !envUser ? await credentialRuntime() : null;
  return {
    token: envToken ?? (runtime ? await storedKey(runtime, TOKEN_PROVIDER) : undefined),
    user: envUser ?? (runtime ? await storedKey(runtime, USER_PROVIDER) : undefined),
    device: envValue("LEAFCODE_PI_PUSHOVER_DEVICE") ?? getSetting(DEVICE_SETTING) ?? undefined,
  };
}

export async function getPushoverSettingsDto(): Promise<PushoverSettingsDto> {
  const credentials = await readPushoverCredentials();
  return {
    hasToken: Boolean(credentials.token),
    hasUser: Boolean(credentials.user),
    device: credentials.device ?? "",
    envManaged: {
      token: Boolean(envValue("LEAFCODE_PI_PUSHOVER_TOKEN")),
      user: Boolean(envValue("LEAFCODE_PI_PUSHOVER_USER")),
      device: Boolean(envValue("LEAFCODE_PI_PUSHOVER_DEVICE")),
    },
  };
}

/** Omitted fields are kept; null clears a stored value. Environment-owned fields are read-only. */
export async function savePushoverSettings(patch: PushoverSettingsPatch): Promise<void> {
  if ((patch.token !== undefined && envValue("LEAFCODE_PI_PUSHOVER_TOKEN")) ||
      (patch.user !== undefined && envValue("LEAFCODE_PI_PUSHOVER_USER")) ||
      (patch.device !== undefined && envValue("LEAFCODE_PI_PUSHOVER_DEVICE"))) {
    throw new PushoverEnvManagedError("環境変数で管理されている項目は変更できません");
  }
  if (patch.token !== undefined || patch.user !== undefined) {
    const runtime = await credentialRuntime();
    for (const [provider, value] of [[TOKEN_PROVIDER, patch.token], [USER_PROVIDER, patch.user]] as const) {
      if (value === undefined) continue;
      if (value === null) await runtime.logout(provider);
      else await runtime.login(provider, "api_key", { prompt: async () => value, notify: () => {} });
    }
  }
  if (patch.device !== undefined) setSetting(DEVICE_SETTING, patch.device);
}
