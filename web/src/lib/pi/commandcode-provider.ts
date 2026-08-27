import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti/static";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { UsageScope } from "@/lib/codexbar/types";

export const COMMANDCODE_PROVIDER_ID = "commandcode";

type ExtensionApiStub = {
  registerProvider: (
    nameOrProvider: string | { id: string },
    config?: Record<string, unknown>,
  ) => void;
  on: (...args: unknown[]) => void;
  registerCommand: (...args: unknown[]) => void;
};

/** Resolve pi-commandcode-provider entry (Next bundled chunks break createRequire alone). */
export function resolveCommandCodeExtensionEntry(
  cwd = process.cwd(),
): string | null {
  const candidates = [
    join(cwd, "node_modules", "pi-commandcode-provider", "index.ts"),
    join(cwd, "..", "node_modules", "pi-commandcode-provider", "index.ts"),
  ];
  try {
    const require = createRequire(import.meta.url);
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

const REGISTRATION_KEY = "__leafcodeCommandCodeRegistration" as const;

function registrationPromise(): Promise<CommandCodeRegistration[] | null> {
  const globalRef = globalThis as typeof globalThis & {
    [REGISTRATION_KEY]?: Promise<CommandCodeRegistration[] | null>;
  };
  if (!globalRef[REGISTRATION_KEY]) {
    globalRef[REGISTRATION_KEY] = loadCommandCodeRegistrations();
  }
  return globalRef[REGISTRATION_KEY];
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
  if (runtime.getProvider(COMMANDCODE_PROVIDER_ID)) return;

  if (!scope?.authPath) syncCommandCodeApiKeyEnv();
  const registrations = await registrationPromise();
  if (!registrations || runtime.getProvider(COMMANDCODE_PROVIDER_ID)) return;
  for (const registration of registrations) {
    if (registration.kind === "provider") {
      runtime.registerProvider(
        registration.name,
        withAccountScope(
          withImageDowngrade(registration.config),
          scope,
        ) as never,
      );
    } else {
      runtime.registerNativeProvider(registration.provider as never);
    }
  }

  if (!runtime.getProvider(COMMANDCODE_PROVIDER_ID)) {
    console.warn(
      "[LeafCodePi] commandcode provider factory finished but provider is still missing",
    );
  }
}
