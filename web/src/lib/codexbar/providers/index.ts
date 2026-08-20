/**
 * Native usage providers (CodexBarWin ports).
 *
 * v1 supported: codex, claude, cursor, openrouter, synthetic, commandcode.
 *
 * SKIPPED for v1 (cookie scrapers / complex local clients):
 * - opencode-go
 * - ollama (cloud cookie / local)
 * - qwen-cloud
 * Documented here so callers do not expect them until a later port.
 */

import type { IUsageProvider } from "@/lib/codexbar/types";
import { claudeProvider } from "@/lib/codexbar/providers/claude";
import { codexProvider } from "@/lib/codexbar/providers/codex";
import { commandcodeProvider } from "@/lib/codexbar/providers/commandcode";
import { cursorProvider } from "@/lib/codexbar/providers/cursor";
import { openrouterProvider } from "@/lib/codexbar/providers/openrouter";
import { syntheticProvider } from "@/lib/codexbar/providers/synthetic";

export const NATIVE_PROVIDERS: IUsageProvider[] = [
  codexProvider,
  claudeProvider,
  cursorProvider,
  openrouterProvider,
  syntheticProvider,
  commandcodeProvider,
];
