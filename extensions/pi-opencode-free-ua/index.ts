import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AnyModel, Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Pi 1.x supplies x-opencode-client: pi. The old missing-header hook never ran. */
export function openCodeHeaders(headers: ProviderHeaders = {}, sessionId?: string): ProviderHeaders {
  const result = { ...headers };
  for (const name of ["x-opencode-client", "x-opencode-session"]) {
    const keys = Object.keys(result).filter((key) => key.toLowerCase() === name);
    const value = keys.map((key) => result[key]).find((value) => typeof value === "string" && value.trim());
    for (const key of keys) delete result[key];
    result[name] = name === "x-opencode-client"
      ? (!value || value === "pi" ? "opencode" : value)
      : (value || sessionId || randomUUID());
  }
  return result;
}

/** Free Responses models use Zen's Chat Completions route; paid models stay untouched. */
export function freeTierModel<T extends AnyModel>(model: T): T {
  if (model.provider !== "opencode" || (model.type && model.type !== "chat") ||
      model.api !== "openai-responses" || !model.id.endsWith("-free")) return model;
  const chat = model as Model<Api>;
  return {
    ...chat,
    api: "openai-completions",
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsStrictMode: true,
      maxTokensField: "max_tokens",
    },
  } as T;
}

/** Decorate the native provider, retaining auth, session routing and classifiers. */
export function freeTierProvider(base: Provider): Provider {
  return {
    ...base,
    getModels: () => base.getModels().map(freeTierModel),
    getAllModels: () => (base.getAllModels?.() ?? base.getModels()).map(freeTierModel),
    stream: (model, context, options) => base.stream(freeTierModel(model), context, {
      ...options, headers: openCodeHeaders(options?.headers, options?.sessionId),
    } as NonNullable<typeof options>),
    streamSimple: (model, context, options) => base.streamSimple(freeTierModel(model), context, {
      ...options, headers: openCodeHeaders(options?.headers, options?.sessionId),
    }),
    ...(base.classify ? {
      classify: (model, context, options) => base.classify!(model, context, {
        ...options, headers: openCodeHeaders(options?.headers),
      }),
    } : {}),
  };
}

/** Resolve from the running CLI first, then the extension and LeafCodePi SDK roots.
 * pi-ai exposes import-only subpaths, so require.resolve(specifier) is not usable.
 */
export function resolveOpenCodeProviderPath(): string {
  const extensionRoot = dirname(fileURLToPath(import.meta.url));
  const bases = [
    ...(process.argv[1] ? [resolve(process.argv[1])] : []),
    fileURLToPath(import.meta.url),
    join(extensionRoot, "../../backend/package.json"),
    join(extensionRoot, "../../web/package.json"),
    join(process.cwd(), "backend/package.json"),
    join(process.cwd(), "web/package.json"),
  ];
  for (const base of bases) {
    for (const root of createRequire(base).resolve.paths("@earendil-works/pi-ai") ?? []) {
      const entry = join(root, "@earendil-works/pi-ai/dist/providers/opencode.js");
      if (existsSync(entry)) return entry;
    }
  }
  throw new Error("pi-opencode-free-ua requires Pi SDK >= 1.0.0 (native OpenCode provider not found)");
}

export default async function (pi: ExtensionAPI): Promise<void> {
  pi.on("message_end", ({ message }) => {
    if (message.role !== "assistant" || message.provider !== "opencode" ||
        message.stopReason !== "error" || !message.model.endsWith("-free") ||
        !/FreeTierError|free tier can only be used from within OpenCode/i.test(message.errorMessage ?? "") ||
        message.errorMessage?.includes("[pi-opencode-free-ua]")) return;
    return { message: {
      ...message,
      errorMessage: `${message.errorMessage}\n[pi-opencode-free-ua] OpenCode側の無料枠クライアント制限。/reload後も続く場合はOpenCode本体または別の無料モデルを利用。有料モデルへの自動切替は行わない。`,
    } };
  });
  const { opencodeProvider } = await import(pathToFileURL(resolveOpenCodeProviderPath()).href) as {
    opencodeProvider: () => Provider;
  };
  pi.registerProvider(freeTierProvider(opencodeProvider()));
}
