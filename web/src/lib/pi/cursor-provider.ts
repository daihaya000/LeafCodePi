import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const CURSOR_PROVIDER_ID = "cursor";

type ExtensionApiStub = {
  registerProvider: (nameOrProvider: string | { id: string }, config?: Record<string, unknown>) => void;
  on: (...args: unknown[]) => void;
  registerCommand: (...args: unknown[]) => void;
};

/**
 * Load @rahularya01/pi-cursor so Cursor subscription OAuth + models appear in Pi.
 * Unofficial community extension; uses Cursor account tokens (IDE / CLI / /login).
 */
export async function registerCursorProvider(runtime: ModelRuntime): Promise<void> {
  if (runtime.getProvider(CURSOR_PROVIDER_ID)) return;

  let factory: ((api: ExtensionApiStub) => void | Promise<void>) | null = null;
  try {
    const mod = (await import("@rahularya01/pi-cursor")) as {
      default?: (api: ExtensionApiStub) => void | Promise<void>;
    };
    if (typeof mod.default === "function") factory = mod.default;
  } catch (error) {
    console.warn(
      "[LeafCodePi] @rahularya01/pi-cursor could not be loaded:",
      error instanceof Error ? error.message : error,
    );
    return;
  }
  if (!factory) return;

  const api: ExtensionApiStub = {
    registerProvider(nameOrProvider, config) {
      if (typeof nameOrProvider === "string") {
        runtime.registerProvider(nameOrProvider, (config ?? {}) as never);
        return;
      }
      runtime.registerNativeProvider(nameOrProvider as never);
    },
    on() {
      /* session hooks are optional for BFF login + chat via registered provider */
    },
    registerCommand() {
      /* CLI slash commands not used in the WebUI */
    },
  };

  try {
    await factory(api);
  } catch (error) {
    console.warn(
      "[LeafCodePi] cursor provider registration failed:",
      error instanceof Error ? error.message : error,
    );
  }
}
