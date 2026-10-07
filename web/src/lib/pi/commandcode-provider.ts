import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti/static";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";
import type { UsageScope } from "@/lib/codexbar/types";
import { withCommandCodeStreamRetry } from "./commandcode-stream-retry";

export const COMMANDCODE_PROVIDER_ID = "commandcode";

type ExtensionApiStub = {
  registerProvider: (
    nameOrProvider: string | { id: string },
    config?: Record<string, unknown>,
  ) => void;
  on: (...args: unknown[]) => void;
  registerCommand: (...args: unknown[]) => void;
};

/** Resolve the web dependency from both Next chunks and backend/runtime bundles. */
export function resolveCommandCodeExtensionEntry(
  cwd = process.cwd(),
  moduleUrl = import.meta.url,
): string | null {
  const candidates = [
    // Backend runs from the repository root, with no provider in backend/node_modules.
    fileURLToPath(new URL("../../web/node_modules/pi-commandcode-provider/index.ts", moduleUrl)),
    join(cwd, "web", "node_modules", "pi-commandcode-provider", "index.ts"),
    join(cwd, "..", "web", "node_modules", "pi-commandcode-provider", "index.ts"),
    join(cwd, "node_modules", "pi-commandcode-provider", "index.ts"),
    join(cwd, "..", "node_modules", "pi-commandcode-provider", "index.ts"),
  ];
  try {
    const require = createRequire(moduleUrl);
    const pkgJson = require.resolve("pi-commandcode-provider/package.json");
    candidates.unshift(join(dirname(pkgJson), "index.ts"));
  } catch {
    /* fall through to cwd candidates */
  }
  for (const file of candidates) {
    if (existsSync(/* turbopackIgnore: true */ file)) return file;
  }
  return null;
}

/** pi-ai transform-messages.ts uses these exact strings; keep them identical. */
const USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const TOOL_IMAGE_PLACEHOLDER =
  "(tool image omitted: model does not support images)";

type ContentBlock = { type: string; text?: string };
type MessageLike = { role?: string; content?: unknown };

function replaceImages(
  content: ContentBlock[],
  placeholder: string,
): ContentBlock[] {
  const result: ContentBlock[] = [];
  let previousWasPlaceholder = false;
  for (const block of content) {
    if (block.type === "image") {
      if (!previousWasPlaceholder)
        result.push({ type: "text", text: placeholder });
      previousWasPlaceholder = true;
      continue;
    }
    result.push(block);
    previousWasPlaceholder = block.text === placeholder;
  }
  return result;
}

/**
 * Drop image blocks for text-only models.
 *
 * pi-ai runs this in `transformMessages` for its own APIs, but a native provider
 * (`streamSimple`) receives the raw context, so the Command Code provider throws
 * "does not support image content in tool results" and kills the task instead.
 * The `read` tool already annotates the omission in text; only the blob must go.
 */
export function downgradeUnsupportedImages<T extends { messages?: unknown }>(
  model: { input?: readonly string[] } | undefined,
  context: T,
): T {
  if (model?.input?.includes("image")) return context;
  if (!Array.isArray(context?.messages)) return context;

  let changed = false;
  const messages = (context.messages as MessageLike[]).map((message) => {
    if (!Array.isArray(message?.content)) return message;
    const content = message.content as ContentBlock[];
    if (!content.some((block) => block?.type === "image")) return message;
    const placeholder =
      message.role === "toolResult"
        ? TOOL_IMAGE_PLACEHOLDER
        : USER_IMAGE_PLACEHOLDER;
    changed = true;
    return { ...message, content: replaceImages(content, placeholder) };
  });

  return changed ? { ...context, messages } : context;
}

type StreamSimple = (
  model: { input?: readonly string[] } | undefined,
  context: { messages?: unknown },
  options?: unknown,
) => unknown;

/** Wrap the extension's `streamSimple` so text-only models never receive image blocks. */
export function withImageDowngrade(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const stream = config.streamSimple;
  if (typeof stream !== "function") return config;
  const inner = stream as StreamSimple;
  return {
    ...config,
    streamSimple: (
      model: Parameters<StreamSimple>[0],
      context: Parameters<StreamSimple>[1],
      options?: unknown,
    ) => inner(model, downgradeUnsupportedImages(model, context), options),
  };
}

/**
 * Align LeafCodePi / CodexBar env name with the extension's COMMANDCODE_API_KEY.
 */
export function syncCommandCodeApiKeyEnv(): void {
  const primary = process.env.COMMANDCODE_API_KEY?.trim();
  if (primary) return;
  const alt = process.env.COMMAND_CODE_API_KEY?.trim();
  if (alt) process.env.COMMANDCODE_API_KEY = alt;
}

/** Keep API-key login available without borrowing another account's environment key. */
export function withCommandCodeApiKeyAuth(
  provider: Provider,
  accountScoped: boolean,
): Provider {
  type ApiKeyAuth = NonNullable<Provider["auth"]["apiKey"]>;
  const resolveKey = async ({ credential, ctx }: Parameters<ApiKeyAuth["resolve"]>[0]) => {
    const stored = credential?.key?.trim();
    if (stored) return { key: stored, source: "stored API key" };
    if (accountScoped) return undefined;
    for (const name of ["COMMANDCODE_API_KEY", "COMMAND_CODE_API_KEY"]) {
      const key = (await ctx.env(name))?.trim();
      if (key) return { key, source: name };
    }
    return undefined;
  };
  return {
    ...provider,
    auth: {
      ...provider.auth,
      apiKey: {
        name: "Command Code API key",
        async login(interaction) {
          interaction.notify({
            type: "info",
            message: "GOAT契約のCommand Codeアカウントで発行したAPIキーを入力してください",
            links: [{ url: "https://commandcode.ai/studio", label: "Command Code Studio" }],
          });
          const key = (await interaction.prompt({
            type: "secret",
            message: "Command Code API key",
            placeholder: "user_…",
          })).trim();
          if (!key) throw new Error("API キーが必要です");
          const baseUrl = (provider.baseUrl ?? "https://api.commandcode.ai")
            .replace(/\/provider\/v1\/?$/, "").replace(/\/+$/, "");
          const response = await fetch(`${baseUrl}/alpha/whoami`, {
            headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
            signal: AbortSignal.any([interaction.signal, AbortSignal.timeout(20_000)]),
            cache: "no-store",
          });
          if (!response.ok) {
            throw new Error(`Command Code API キーの確認に失敗しました (${response.status})`);
          }
          return { type: "api_key", key };
        },
        async check(input) {
          const resolved = await resolveKey(input);
          return resolved ? { type: "api_key", source: resolved.source } : undefined;
        },
        async resolve(input) {
          const resolved = await resolveKey(input);
          return resolved
            ? { auth: { apiKey: resolved.key }, source: resolved.source }
            : undefined;
        },
      },
    },
  };
}

function withAccountScope(
  config: Record<string, unknown>,
  scope: UsageScope | undefined,
): Record<string, unknown> {
  // Account runtimes must use their stored OAuth credential, never the process env key.
  return scope?.authPath ? { ...config, apiKey: undefined } : config;
}

type CommandCodeRegistration =
  | { kind: "provider"; name: string; config: Record<string, unknown> }
  | { kind: "native"; provider: { id: string } };

const REGISTRATION_KEY = "__leafcodeCommandCodeRegistrationState" as const;
const REGISTRATION_RETRY_MS = 5_000;

type RegistrationState = {
  promise?: Promise<CommandCodeRegistration[] | null>;
  retryAt: number;
  runtimes: WeakMap<ModelRuntime, Promise<void>>;
  incomplete: WeakSet<ModelRuntime>;
};

function registrationState(): RegistrationState {
  const globalRef = globalThis as typeof globalThis & {
    [REGISTRATION_KEY]?: RegistrationState;
  };
  return (globalRef[REGISTRATION_KEY] ??= { retryAt: 0, runtimes: new WeakMap(), incomplete: new WeakSet() });
}

function registrationPromise(cache: RegistrationState): Promise<CommandCodeRegistration[] | null> {
  if (!cache.promise || Date.now() >= cache.retryAt) {
    // Share one load across runtimes; successful catalogs stay cached, failures expire.
    cache.retryAt = Infinity;
    cache.promise = loadCommandCodeRegistrations().then((registrations) => {
      const hasModels = registrations?.some((registration) => registration.kind === "native" ||
        (Array.isArray(registration.config.models) && registration.config.models.length > 0));
      cache.retryAt = hasModels ? Infinity : Date.now() + REGISTRATION_RETRY_MS;
      return registrations;
    }, () => {
      cache.retryAt = Date.now() + REGISTRATION_RETRY_MS;
      return null;
    });
  }
  return cache.promise;
}

/** Retry only our incomplete registrations, respecting the shared catalog backoff. */
export function shouldRetryCommandCodeRegistration(runtime: ModelRuntime): boolean {
  const cache = registrationState();
  return cache.incomplete.has(runtime) &&
    (cache.retryAt === Infinity || Date.now() >= cache.retryAt);
}

/** @internal テスト用。プロセス共有の拡張ロード結果を破棄する。 */
export function __resetCommandCodeProviderCacheForTests(): void {
  delete (globalThis as typeof globalThis & { [REGISTRATION_KEY]?: unknown })[
    REGISTRATION_KEY
  ];
}

async function loadCommandCodeRegistrations(): Promise<
  CommandCodeRegistration[] | null
> {
  const entry = resolveCommandCodeExtensionEntry();
  if (!entry) {
    console.warn("[LeafCodePi] pi-commandcode-provider is not installed");
    return null;
  }

  let factory: ((api: ExtensionApiStub) => void | Promise<void>) | null = null;
  try {
    const jiti = createJiti(import.meta.url, { moduleCache: false });
    const mod = (await jiti.import(pathToFileURL(entry).href, {
      default: true,
    })) as unknown;
    if (typeof mod === "function") {
      factory = mod as (api: ExtensionApiStub) => void | Promise<void>;
    }
  } catch (error) {
    console.warn(
      "[LeafCodePi] pi-commandcode-provider could not be loaded:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
  if (!factory) {
    console.warn(
      "[LeafCodePi] pi-commandcode-provider has no default factory export",
    );
    return null;
  }

  const registrations: CommandCodeRegistration[] = [];
  const api: ExtensionApiStub = {
    registerProvider(nameOrProvider, config) {
      registrations.push(
        typeof nameOrProvider === "string"
          ? { kind: "provider", name: nameOrProvider, config: config ?? {} }
          : { kind: "native", provider: nameOrProvider },
      );
    },
    on() {
      /* message_end overflow hook is optional in the WebUI BFF */
    },
    registerCommand() {
      /* /commandcode-refresh|status are CLI-oriented; unused in WebUI */
    },
  };

  try {
    await factory(api);
    return registrations;
  } catch (error) {
    console.warn(
      "[LeafCodePi] commandcode provider registration failed:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/**
 * Load pi-commandcode-provider (patlux).
 *
 * Transport selection (in-package):
 * - Provider API (`/provider/v1/...`) when the account allows it
 * - `/alpha/generate` only after Provider API returns `403 upgrade_required` (Go plan)
 *
 * Unofficial community extension; Command Code terms apply.
 */
export async function registerCommandCodeProvider(
  runtime: ModelRuntime,
  scope?: UsageScope,
): Promise<void> {
  const cache = registrationState();
  const existing = cache.runtimes.get(runtime);
  if (existing) return existing;
  // Existing external registrations need no model scan; retry only our incomplete installs.
  if (runtime.getProvider(COMMANDCODE_PROVIDER_ID) && !cache.incomplete.has(runtime)) return;
  cache.incomplete.add(runtime);
  const promise = installCommandCodeProvider(runtime, scope, cache);
  cache.runtimes.set(runtime, promise);
  try {
    await promise;
  } finally {
    if (cache.runtimes.get(runtime) === promise) cache.runtimes.delete(runtime);
  }
}

async function installCommandCodeProvider(
  runtime: ModelRuntime,
  scope: UsageScope | undefined,
  cache: RegistrationState,
): Promise<void> {
  if (!scope?.authPath) syncCommandCodeApiKeyEnv();
  const registrations = await registrationPromise(cache);
  if (!registrations) return;
  for (const registration of registrations) {
    if (registration.kind === "provider") {
      runtime.registerProvider(
        registration.name,
        withAccountScope(
          withImageDowngrade(withCommandCodeStreamRetry(registration.config)),
          scope,
        ) as never,
      );
    } else {
      runtime.registerNativeProvider(registration.provider as never);
    }
  }

  const provider = runtime.getProvider(COMMANDCODE_PROVIDER_ID);
  if (!provider) {
    console.warn(
      "[LeafCodePi] commandcode provider factory finished but provider is still missing",
    );
    return;
  }
  runtime.registerNativeProvider(
    withCommandCodeApiKeyAuth(provider, Boolean(scope?.authPath)),
  );
  await runtime.refresh({ providers: [COMMANDCODE_PROVIDER_ID], allowNetwork: false });
  if (runtime.getModels(COMMANDCODE_PROVIDER_ID).length > 0) cache.incomplete.delete(runtime);
}
