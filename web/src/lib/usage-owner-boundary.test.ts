import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fetchNativeUsage } from "@/lib/codexbar/orchestrator";
import { consumeCodexResetCredit } from "@/lib/codexbar/providers/openai-codex-reset";
import { consumeClaudeResetGrant } from "@/lib/codexbar/providers/anthropic-reset";
import { attachTokenUsage, recordAssistantTokenUsage } from "@/lib/codexbar/token-usage";
import { emptyUsage } from "@/lib/codexbar";
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "leafcode-usage-refused-")); vi.stubEnv("LEAFCODE_PI_DATA_DIR", root); vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE", "next"); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
it("Next cannot poll native providers or redeem either provider's reset credits", async () => {
  await expect(fetchNativeUsage({ forceRefresh: true })).rejects.toThrow("owned by Backend");
  await expect(consumeCodexResetCredit({} as Parameters<typeof consumeCodexResetCredit>[0], { creditId: "c" })).rejects.toThrow("owned by Backend");
  await expect(consumeClaudeResetGrant({} as Parameters<typeof consumeClaudeResetGrant>[0], { grantId: "g" })).rejects.toThrow("owned by Backend");
  expect(readdirSync(root)).toEqual([]);
});
it("Next telemetry cannot open/migrate SQLite even for reads, while preserving safe empty output", () => {
  expect(attachTokenUsage(emptyUsage("empty"))).toMatchObject({ available: false, providers: [] });
  expect(recordAssistantTokenUsage("s", null, { role: "assistant", stopReason: "stop", provider: "anthropic", model: "m", timestamp: Date.now(), usage: { input: 1, output: 1 } })).toBe(false);
  expect(readdirSync(root)).toEqual([]);
});
