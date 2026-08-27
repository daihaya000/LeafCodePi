/**
 * Native usage providers (CodexBarWin ports).
 * Fully native: no CodexBarWin process required at runtime.
 */

import type {
  IUsageProvider,
  UsageProviderDefinition,
  UsageScope,
} from "@/lib/codexbar/types";
import {
  anthropicProvider,
  createAnthropicProvider,
} from "@/lib/codexbar/providers/anthropic";
import {
  openaiCodexProvider,
  createOpenaiCodexProvider,
} from "@/lib/codexbar/providers/openai-codex";
import {
  commandcodeProvider,
  createCommandCodeProvider,
} from "@/lib/codexbar/providers/commandcode";
import {
  createCursorProvider,
  cursorProvider,
} from "@/lib/codexbar/providers/cursor";
import {
  createOllamaCloudProvider,
  ollamaCloudProvider,
} from "@/lib/codexbar/providers/ollama-cloud";
import {
  createOpenCodeGoProvider,
  opencodeGoProvider,
} from "@/lib/codexbar/providers/opencode-go";
import {
  createOpenRouterProvider,
  openrouterProvider,
} from "@/lib/codexbar/providers/openrouter";
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

/** アカウントごとに 1 インスタンス作る（= scope 展開する）プロバイダー。 */
const SCOPED_FACTORIES: Record<string, (scope: UsageScope) => IUsageProvider> =
  {
    "openai-codex": createOpenaiCodexProvider,
    anthropic: createAnthropicProvider,
    "ollama-cloud": createOllamaCloudProvider,
    openrouter: createOpenRouterProvider,
    commandcode: createCommandCodeProvider,
    cursor: createCursorProvider,
    "opencode-go": createOpenCodeGoProvider,
  };

/** Provider definitions used to create one isolated instance per usage scope. */
export const NATIVE_PROVIDER_DEFINITIONS: UsageProviderDefinition[] =
  NATIVE_PROVIDERS.map((provider) => ({
    id: provider.id,
    name: provider.name,
    kind: provider.id in SCOPED_FACTORIES ? "subscription" : "shared",
    create: SCOPED_FACTORIES[provider.id] ?? (() => provider),
  }));
