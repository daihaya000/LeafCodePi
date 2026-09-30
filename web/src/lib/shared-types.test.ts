import { describe, expect, expectTypeOf, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import * as legacy from "@/lib/types";
import * as shared from "@shared/types";
import { BOT_AVATAR_SHAPES, type BotAvatarShape } from "@/lib/bot-avatar";
import type { TaskDetail, QuestionRequestDto, PermissionRequestDto } from "@/lib/types";

describe("shared wire contracts", () => {
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
      copyFileSync(fileURLToPath(new URL("./types.ts", import.meta.url)), join(mirror, "src", "lib", "types.ts"));
      const probe = join(mirror, "probe.ts");
      writeFileSync(probe, 'import { BOT_ROUTINE_RUN_EVENT, type TaskDetail } from "@/lib/types";\nexport const event: "routine" = BOT_ROUTINE_RUN_EVENT;\nexport type Task = TaskDetail;\n');
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
