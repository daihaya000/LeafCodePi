import { NextRequest } from "next/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TransferRecoveryError } from "@/lib/pi/transfer-recovery";
import { MAX_PROMPT_BACKUP_BYTES, PROMPT_FILE_NAMES } from "@/lib/prompt-transfer-format";
import { POST } from "./route";

const { importPromptBackup, reloadLiveSessionsContext } = vi.hoisted(() => ({
  importPromptBackup: vi.fn(),
  reloadLiveSessionsContext: vi.fn(async () => ({ reloaded: 1, deferred: 0, failed: 0, errors: [] })),
}));
vi.mock("@/lib/pi/prompt-transfer", () => ({ exportPromptBackup: vi.fn(), importPromptBackup }));
vi.mock("@/lib/pi/harness", () => ({ reloadLiveSessionsContext }));

const request = () => new NextRequest("http://localhost/api/prompts/transfer", {
  method: "POST", body: JSON.stringify({ action: "import", backup: {}, selected: ["USER.md"] }),
});

beforeEach(() => {
  vi.stubEnv("LEAFCODE_PI_BIND_HOST", "127.0.0.1");
  importPromptBackup.mockReset();
  reloadLiveSessionsContext.mockClear();
});
afterEach(() => { vi.unstubAllEnvs(); });

it("reports an applied import as success when journal cleanup fails, and reloads sessions", async () => {
  importPromptBackup.mockRejectedValueOnce(new TransferRecoveryError("C:/recovery.json", "インポートは完了しましたが、保全ファイルを削除できませんでした", true));
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    imported: ["USER.md"],
    reload: { reloaded: 1 },
    warning: expect.stringContaining("保全ファイル: C:/recovery.json"),
  });
  expect(reloadLiveSessionsContext).toHaveBeenCalledOnce();
});

it("accepts the request envelope around a valid near-limit backup", async () => {
  const base = { format: "leafcode-pi-prompts", version: 1, exportedAt: "2026-09-28T00:00:00.000Z",
    files: Object.fromEntries(PROMPT_FILE_NAMES.map((name) => [name, ""])) };
  const fixedBytes = Buffer.byteLength(JSON.stringify(base), "utf8");
  const text = "\n".repeat(Math.floor((MAX_PROMPT_BACKUP_BYTES - fixedBytes - 2) / (PROMPT_FILE_NAMES.length * 2)));
  const backup = { ...base, files: Object.fromEntries(PROMPT_FILE_NAMES.map((name) => [name, text])) };
  expect(Buffer.byteLength(JSON.stringify(backup), "utf8")).toBeLessThan(MAX_PROMPT_BACKUP_BYTES);
  const body = JSON.stringify({ action: "import", backup, selected: ["USER.md"] });
  expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(MAX_PROMPT_BACKUP_BYTES);
  importPromptBackup.mockResolvedValueOnce(["USER.md"]);
  const response = await POST(new NextRequest("http://localhost/api/prompts/transfer", { method: "POST", body }));
  expect(response.status).toBe(200);
  expect((await response.json()).imported).toEqual(["USER.md"]);
});

it("does not mark a failed rollback as an applied import", async () => {
  importPromptBackup.mockRejectedValueOnce(new TransferRecoveryError("C:/recovery.json"));
  const response = await POST(request());
  expect(response.status).toBe(500);
  expect(reloadLiveSessionsContext).not.toHaveBeenCalled();
});
