import { describe, expect, expectTypeOf, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import * as legacy from "@/lib/types";
import * as shared from "@shared/types";
import { PROVIDER_AUTH_EVENT_LIMIT, PROVIDER_AUTH_BUFFER_LIMIT, PROVIDER_AUTH_STREAM_LIMIT } from "@shared/provider-auth-contract.mjs";
import { BOT_AVATAR_SHAPES, type BotAvatarShape } from "@/lib/bot-avatar";
import type { TaskDetail, QuestionRequestDto, PermissionRequestDto } from "@/lib/types";

describe("shared wire contracts", () => {
  it("keeps Provider SSE byte and subscription limits in the shared typed contract", () => {
    expect(PROVIDER_AUTH_EVENT_LIMIT).toBe(65536);
    expect(PROVIDER_AUTH_BUFFER_LIMIT).toBe(1024 * 1024);
    expect(PROVIDER_AUTH_STREAM_LIMIT).toBe(32);
  });
  it("keeps the existing import entrypoint and constant identities", () => {
    expect(Object.keys(legacy).sort()).toEqual(Object.keys(shared).sort());
    for (const key of Object.keys(shared) as (keyof typeof shared)[]) {
      expect(legacy[key]).toBe(shared[key]);
    }
    expect(legacy.NO_PROJECT_NAME).toBe("プロジェクトなし");
    expect(legacy.BOT_CODE_SESSION_CHANGED_EVENT).toBe("code_session_changed");
    expect(legacy.BOT_ROUTINE_RUN_EVENT).toBe("routine");
  });

  it("preserves task, permission and question type exports", () => {
    expectTypeOf<TaskDetail>().toEqualTypeOf<shared.TaskDetail>();
    expectTypeOf<PermissionRequestDto>().toEqualTypeOf<shared.PermissionRequestDto>();
    expectTypeOf<QuestionRequestDto>().toEqualTypeOf<shared.QuestionRequestDto>();
  });

  it("typechecks a self-contained production mirror without checkout dependencies", () => {
    const mirror = mkdtempSync(join(tmpdir(), "leafcode-pi-shared-contract-"));
    try {
      mkdirSync(join(mirror, "shared"), { recursive: true });
      mkdirSync(join(mirror, "src", "lib"), { recursive: true });
      copyFileSync(fileURLToPath(new URL("../../tsconfig.json", import.meta.url)), join(mirror, "tsconfig.json"));
      copyFileSync(fileURLToPath(new URL("../../../shared/types.ts", import.meta.url)), join(mirror, "shared", "types.ts"));
      // The mirror copies the whole shared directory in production; the contract files it imports must
      // be present here too, or the probe fails on a missing module instead of a broken contract.
      for (const contract of ["bot-tools.mjs", "bot-tools.d.mts", "mcp-auth-snapshot.mjs", "mcp-auth-snapshot.d.mts",
        "mcp-preset-request.mjs", "mcp-preset-request.d.mts", "mcp-bearer-save-request.mjs", "mcp-bearer-save-request.d.mts",
        "mcp-headers-save-request.mjs", "mcp-headers-save-request.d.mts", "mcp-bearer-remove-request.mjs", "mcp-bearer-remove-request.d.mts",
        "mcp-auth-remove-request.mjs", "mcp-auth-remove-request.d.mts", "mcp-oauth-start-request.mjs", "mcp-oauth-start-request.d.mts",
        "mcp-oauth-complete-request.mjs", "mcp-oauth-complete-request.d.mts", "mcp-server-list.mjs", "mcp-server-list.d.mts"]) {
        copyFileSync(fileURLToPath(new URL(`../../../shared/${contract}`, import.meta.url)), join(mirror, "shared", contract));
      }
      copyFileSync(fileURLToPath(new URL("./types.ts", import.meta.url)), join(mirror, "src", "lib", "types.ts"));
      const probe = join(mirror, "probe.ts");
      // Vitest transpilation alone does not check type assertions. The mirror compiler checks both
      // directions against the runtime vocabulary and rejects the retired MCP gateway name.
      const botToolContract = `
import type { BotToolName } from "@/lib/types";
const botToolNames = ${JSON.stringify(shared.BOT_TOOL_NAMES)} as const satisfies readonly BotToolName[];
export const completeBotVocabulary: Exclude<BotToolName, typeof botToolNames[number]> extends never ? true : false = true;
// @ts-expect-error The retired gateway is not a configurable Bot tool.
export const retiredGateway: BotToolName = "mcp";
`;
      writeFileSync(probe, 'import { BOT_ROUTINE_RUN_EVENT, type TaskDetail } from "@/lib/types";\nimport { parseMcpBearerSaveRequest, type McpBearerSaveResult } from "@shared/mcp-bearer-save-request.mjs";\nimport { parseMcpHeadersSaveRequest, type McpHeadersSaveResult } from "@shared/mcp-headers-save-request.mjs";\nimport { parseMcpBearerRemoveRequest, type McpBearerRemoveResult } from "@shared/mcp-bearer-remove-request.mjs";\nimport { parseMcpAuthRemoveRequest, publicMcpAuthRemoveResult, type McpAuthRemoveResult } from "@shared/mcp-auth-remove-request.mjs";\nimport { parseMcpOAuthStartRequest, publicMcpOAuthStartResult, type McpOAuthStartResult } from "@shared/mcp-oauth-start-request.mjs";\nimport { parseMcpOAuthCompleteRequest, publicMcpOAuthCompleteResult, type McpOAuthCompleteResult } from "@shared/mcp-oauth-complete-request.mjs";\nimport { publicMcpServerList, type McpPublicServerList } from "@shared/mcp-server-list.mjs";\nexport function mcpList(input: unknown): McpPublicServerList | null { return publicMcpServerList(input); }\nexport function oauthComplete(input: unknown): string | undefined { const result = parseMcpOAuthCompleteRequest(input); return result.ok ? result.value.input : undefined; }\nexport function oauthCompleted(input: unknown): McpOAuthCompleteResult | null { return publicMcpOAuthCompleteResult(input); }\nexport function oauthStart(input: unknown): "start" | undefined { const result = parseMcpOAuthStartRequest(input); return result.ok ? result.value.action : undefined; }\nexport function oauthStarted(input: unknown): McpOAuthStartResult | null { return publicMcpOAuthStartResult(input); }\nexport function authRemoval(input: unknown): "bearer" | "headers" | "oauth" | undefined { const result = parseMcpAuthRemoveRequest(input); return result.ok ? result.value.type : undefined; }\nexport function authRemoved(input: unknown): McpAuthRemoveResult | null { return publicMcpAuthRemoveResult(input); }\nexport const event: "routine" = BOT_ROUTINE_RUN_EVENT;\nexport type Task = TaskDetail;\nexport function parse(input: unknown): string | null { const result = parseMcpBearerSaveRequest(input); return result.ok ? result.value.token : null; }\nexport function status(result: McpBearerSaveResult): string { return result.auth.credentialStatus; }\nexport function parseHeaders(input: unknown): Record<string, string> | null { const result = parseMcpHeadersSaveRequest(input); return result.ok ? result.value.headers : null; }\nexport function headerStatus(result: McpHeadersSaveResult): string { return result.auth.credentialStatus; }\nexport function removal(input: unknown): string | undefined { const result = parseMcpBearerRemoveRequest(input); return result.ok ? result.value.type : undefined; }\nexport function removed(result: McpBearerRemoveResult): string { return result.auth.name; }\n' + botToolContract);
      const config = ts.readConfigFile(join(mirror, "tsconfig.json"), ts.sys.readFile);
      expect(config.error).toBeUndefined();
      const options: ts.CompilerOptions = {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        strict: true,
        noEmit: true,
        types: [],
        baseUrl: mirror,
        paths: config.config.compilerOptions.paths,
      };
      const resolved = ts.resolveModuleName("@shared/types", probe, options, ts.sys);
      expect(resolved.resolvedModule?.resolvedFileName.replaceAll("\\", "/")).toBe(join(mirror, "shared", "types.ts").replaceAll("\\", "/"));
      const program = ts.createProgram([probe], options);
      expect(ts.getPreEmitDiagnostics(program).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
    } finally {
      rmSync(mirror, { recursive: true, force: true });
    }
  });

  it("keeps wire avatar IDs identical to frontend rendering IDs", () => {
    expectTypeOf<BotAvatarShape>().toEqualTypeOf<shared.BotAvatarShape>();
    expect(new Set(BOT_AVATAR_SHAPES.map((shape) => shape.id)).size).toBe(BOT_AVATAR_SHAPES.length);
  });
});
