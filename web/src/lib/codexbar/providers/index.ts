/**
 * Native usage providers (CodexBarWin ports).
 * Fully native: no CodexBarWin process required at runtime.
 */

import type {
  IUsageProvider,
  UsageProviderDefinition,
  UsageScope,
} from "@/lib/codexbar/types";
import { anthropicProvider, createAnthropicProvider } from "@/lib/codexbar/providers/anthropic";
import { openaiCodexProvider, createOpenaiCodexProvider } from "@/lib/codexbar/providers/openai-codex";
import { commandcodeProvider } from "@/lib/codexbar/providers/commandcode";
import { cursorProvider } from "@/lib/codexbar/providers/cursor";
import { ollamaCloudProvider } from "@/lib/codexbar/providers/ollama-cloud";
import { opencodeGoProvider } from "@/lib/codexbar/providers/opencode-go";
import { openrouterProvider } from "@/lib/codexbar/providers/openrouter";
import { qwenCloudProvider } from "@/lib/codexbar/providers/qwen-cloud";
import { syntheticProvider } from "@/lib/codexbar/providers/synthetic";

export const NATIVE_PROVIDERS: IUsageProvider[] = [
  openaiCodexProvider,
  anthropicProvider,
  cursorProvider,
  openrouterProvider,
  syntheticProvider,
  commandcodeProvider,
  opencodeGoProvider,
  ollamaCloudProvider,
  qwenCloudProvider,
];

const SUBSCRIPTION_FACTORIES: Record<
  string,
  (scope: UsageScope) => IUsageProvider
> = {
  "openai-codex": createOpenaiCodexProvider,
  anthropic: createAnthropicProvider,
};

/** Provider definitions used to create one isolated instance per usage scope. */
export const NATIVE_PROVIDER_DEFINITIONS: UsageProviderDefinition[] =
  NATIVE_PROVIDERS.map((provider) => ({
    id: provider.id,
    name: provider.name,
    kind: provider.id in SUBSCRIPTION_FACTORIES ? "subscription" : "shared",
    create: SUBSCRIPTION_FACTORIES[provider.id] ?? (() => provider),
  }));
