/**
 * Native usage providers (CodexBarWin ports).
 * Fully native: no CodexBarWin process required at runtime.
 */

import type { IUsageProvider } from "@/lib/codexbar/types";
import { claudeProvider } from "@/lib/codexbar/providers/claude";
import { codexProvider } from "@/lib/codexbar/providers/codex";
import { commandcodeProvider } from "@/lib/codexbar/providers/commandcode";
import { cursorProvider } from "@/lib/codexbar/providers/cursor";
import { ollamaProvider } from "@/lib/codexbar/providers/ollama";
import { opencodeGoProvider } from "@/lib/codexbar/providers/opencode-go";
import { openrouterProvider } from "@/lib/codexbar/providers/openrouter";
import { qwenCloudProvider } from "@/lib/codexbar/providers/qwen-cloud";
import { syntheticProvider } from "@/lib/codexbar/providers/synthetic";

export const NATIVE_PROVIDERS: IUsageProvider[] = [
  codexProvider,
  claudeProvider,
  cursorProvider,
  openrouterProvider,
  syntheticProvider,
  commandcodeProvider,
  opencodeGoProvider,
  ollamaProvider,
  qwenCloudProvider,
];
