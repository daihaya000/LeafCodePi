import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti/static";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const COMMANDCODE_PROVIDER_ID = "commandcode";

type ExtensionApiStub = {
  registerProvider: (nameOrProvider: string | { id: string }, config?: Record<string, unknown>) => void;
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
    if (existsSync(file)) return file;
  }
  return null;
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

/**
 * Load pi-commandcode-provider (patlux).
 *
 * Transport selection (in-package):
 * - Provider API (`/provider/v1/...`) when the account allows it
 * - `/alpha/generate` only after Provider API returns `403 upgrade_required` (Go plan)
 *
 * Unofficial community extension; Command Code terms apply.
 */
export async function registerCommandCodeProvider(runtime: ModelRuntime): Promise<void> {
  if (runtime.getProvider(COMMANDCODE_PROVIDER_ID)) return;

  syncCommandCodeApiKeyEnv();

  const entry = resolveCommandCodeExtensionEntry();
  if (!entry) {
    console.warn("[LeafCodePi] pi-commandcode-provider is not installed");
    return;
  }

  let factory: ((api: ExtensionApiStub) => void | Promise<void>) | null = null;
  try {
    const jiti = createJiti(import.meta.url, { moduleCache: false });
    const mod = (await jiti.import(pathToFileURL(entry).href, { default: true })) as unknown;
    if (typeof mod === "function") {
      factory = mod as (api: ExtensionApiStub) => void | Promise<void>;
    }
  } catch (error) {
    console.warn(
      "[LeafCodePi] pi-commandcode-provider could not be loaded:",
      error instanceof Error ? error.message : error,
    );
    return;
  }
  if (!factory) {
    console.warn("[LeafCodePi] pi-commandcode-provider has no default factory export");
    return;
  }

  const api: ExtensionApiStub = {
    registerProvider(nameOrProvider, config) {
      if (typeof nameOrProvider === "string") {
        runtime.registerProvider(nameOrProvider, (config ?? {}) as never);
        return;
      }
      runtime.registerNativeProvider(nameOrProvider as never);
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
  } catch (error) {
    console.warn(
      "[LeafCodePi] commandcode provider registration failed:",
      error instanceof Error ? error.message : error,
    );
    return;
  }

  if (!runtime.getProvider(COMMANDCODE_PROVIDER_ID)) {
    console.warn(
      "[LeafCodePi] commandcode provider factory finished but provider is still missing",
    );
  }
}
