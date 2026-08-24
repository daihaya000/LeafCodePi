/**
 * Native usage providers (CodexBarWin ports).
 * Fully native: no CodexBarWin process required at runtime.
 */

import type { IUsageProvider } from "@/lib/codexbar/types";
import { anthropicProvider } from "@/lib/codexbar/providers/anthropic";
import { openaiCodexProvider } from "@/lib/codexbar/providers/openai-codex";
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
