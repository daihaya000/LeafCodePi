import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const live = vi.hoisted(() => ({ permissions: vi.fn(), reload: vi.fn(), compaction: vi.fn() }));
vi.mock("@/lib/pi/harness", async (original) => ({ ...await original<typeof import("@/lib/pi/harness")>(),
  applyCodePermissionSettingsToLiveTasks: live.permissions, reloadLiveSessionsContext: live.reload,
  refreshCompactionSuggestions: live.compaction, invalidateHealthCache: vi.fn(),
}));
import { dispatchConfigurationRequest } from "@backend-runtime/configuration/index";
import { getSetting } from "@/lib/pi/web-settings";
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "leafcode-configuration-owner-")); mkdirSync(join(root, "agent"));
  vi.stubEnv("LEAFCODE_PI_DATA_DIR", root); vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
  vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE", "backend"); vi.stubEnv("LEAFCODE_PI_BACKEND_RUNTIME", "1");
  live.permissions.mockReset().mockResolvedValue(undefined); live.compaction.mockReset();
  live.reload.mockReset().mockResolvedValue({ reloaded: 0, failed: 0, deferred: 0, errors: [] });
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
function command(route: string, body: unknown, method = "PUT", runWrite?: (action: () => Promise<Response>) => Promise<Response>) {
  return dispatchConfigurationRequest({ route, method, url: `http://localhost/api/${route}`, authorized: true,
    operationId: randomUUID(), headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(body)) }, runWrite);
}
it("the real owner stores and checkpoints before a failed Code permission apply", async () => {
  live.permissions.mockRejectedValue(new Error("PRIVATE-CREDENTIAL"));
  const response = await command("settings/code-permission-mode", { value: "deny" });
  const body = await response.json();
  expect(response.status).toBe(503); expect(getSetting("code-permission-mode")).toBe("deny");
  expect(body.mutation).toMatchObject({ saved: true, saveStatus: "complete", apply: "failed" });
  expect(body.mutation.revision).toBeTruthy(); expect(JSON.stringify(body)).not.toContain("PRIVATE-CREDENTIAL");
  const ledger = JSON.parse(readFileSync(join(root, "configuration-command.json"), "utf8"));
  expect(ledger.operations.at(-1)).toEqual(body.mutation);
});
it("the real owner defers intercom context reflection without claiming it has applied", async () => {
  live.reload.mockResolvedValue({ reloaded: 0, failed: 0, deferred: 2, errors: [] });
  const response = await command("settings/intercom", { inboundTrigger: "never" }, "PATCH");
  expect(response.status).toBe(200);
  expect((await response.json()).mutation).toMatchObject({ saved: true, saveStatus: "complete", apply: "deferred" });
  expect(live.reload).toHaveBeenCalledOnce();
});
it("maintenance rejection prevents profile mutation", async () => {
  const response = await command("profile", {}, "DELETE", async () => Response.json({ error: "busy" }, { status: 409 }));
  expect(response.status).toBe(409);
  expect((await response.json()).mutation).toMatchObject({ saved: false, saveStatus: "none", revision: null });
});
it("a invalid setting never reaches persistence or live reflection", async () => {
  const response = await command("settings/code-permission-mode", { value: "invalid" });
  expect(response.status).toBe(400); expect((await response.json()).mutation.saved).toBe(false);
  expect(live.permissions).not.toHaveBeenCalled();
});
