import { BackendTestRequest as Request } from "@/test-request";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const profile = vi.hoisted(() => ({
  createProfileBackup: vi.fn(), exportProfile: vi.fn(), importProfileWithBackup: vi.fn(),
  listProfileBackups: vi.fn(), resetProfile: vi.fn(), restoreProfile: vi.fn(), restoreProfilePackages: vi.fn(),
}));
vi.mock("@/lib/profile", () => profile);
// Use the real ownership policy, including Backend identity, rather than a boolean mock.
import { DELETE, PATCH, POST, PUT } from "@backend-runtime/configuration/handlers/profile/route";

const url = "http://127.0.0.1:3010/api/profile";
const summary = { fileCount: 1, bytes: 12 };
function jsonRequest(method: string, body: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
function importRequest() {
  const form = new FormData();
  form.set("profile", new File(["fixture-archive"], "profile.lcp.gz"));
  return new Request(url, { method: "POST", body: form });
}
function expectNoProfileWork() {
  for (const work of Object.values(profile)) expect(work).not.toHaveBeenCalled();
}
async function expectBlocked(response: Response) {
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: "設定の変更・パッケージ復元はBackendでの実行が必要です",
    code: "RUNTIME_NOT_OWNED",
  });
}

describe("/api/profile ownership", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LEAFCODE_PI_BACKEND_RUNTIME", "");
    profile.importProfileWithBackup.mockReturnValue(summary);
    profile.restoreProfile.mockReturnValue(summary);
    profile.resetProfile.mockReturnValue(summary);
    profile.createProfileBackup.mockReturnValue(summary);
    profile.restoreProfilePackages.mockResolvedValue({ packageCount: 2 });
    profile.exportProfile.mockReturnValue({ archive: Buffer.from("fixture-archive") });
    profile.listProfileBackups.mockReturnValue([{ name: "fixture.lcp.gz" }]);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it("client import is refused before form/archive parsing", async () => {
    const request = importRequest();
    const form = vi.spyOn(request, "formData").mockRejectedValue(new Error("private-parser-error"));
    await expectBlocked(await POST(request));
    expect(form).not.toHaveBeenCalled(); expectNoProfileWork();
  });

  it("client restore is refused before body/backup lookup", async () => {
    const request = jsonRequest("PUT", { backup: "private-path" });
    const body = vi.spyOn(request, "json").mockRejectedValue(new Error("private-parser-error"));
    await expectBlocked(await PUT(request));
    expect(body).not.toHaveBeenCalled(); expectNoProfileWork();
  });

  it("client reset cannot delete settings or create a rollback backup", async () => {
    await expectBlocked(await DELETE()); expectNoProfileWork();
  });

  it("client package restore cannot spawn an updater or fall back to backup creation", async () => {
    await expectBlocked(await PATCH(jsonRequest("PATCH", { action: "restore-packages" })));
    expectNoProfileWork();
  });

  it.each(["development", "test", "backend"])("%s owner retains import/restore/reset/package behavior", async (mode) => {
    if (mode === "backend") vi.stubEnv("LEAFCODE_PI_BACKEND_RUNTIME", "1");
    else vi.stubEnv("NODE_ENV", mode);
    expect(await (await POST(importRequest())).json()).toEqual({ ok: true, ...summary });
    expect(profile.importProfileWithBackup).toHaveBeenCalledWith(Buffer.from("fixture-archive"));
    expect(await (await PUT(jsonRequest("PUT", { backup: "fixture.lcp.gz" }))).json()).toEqual({ ok: true, ...summary });
    expect(profile.restoreProfile).toHaveBeenCalledWith("fixture.lcp.gz");
    expect(await (await DELETE()).json()).toEqual({ ok: true, ...summary });
    expect(await (await PATCH(jsonRequest("PATCH", { action: "restore-packages" }))).json()).toEqual({ ok: true, packageCount: 2 });
    expect(profile.resetProfile).toHaveBeenCalledOnce(); expect(profile.restoreProfilePackages).toHaveBeenCalledOnce();
    expect(profile.createProfileBackup).not.toHaveBeenCalled();
  });

  it("client backup-only PATCH writes no live settings and does not restore packages", async () => {
    expect(await (await PATCH(jsonRequest("PATCH", { action: "backup" }))).json()).toEqual({ ok: true, ...summary });
    expect(profile.createProfileBackup).toHaveBeenCalledOnce();
    expect(profile.importProfileWithBackup).not.toHaveBeenCalled(); expect(profile.restoreProfile).not.toHaveBeenCalled();
    expect(profile.resetProfile).not.toHaveBeenCalled(); expect(profile.restoreProfilePackages).not.toHaveBeenCalled();
  });

  it("rejects an upload whose declared size exceeds the archive limit before parsing it", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const request = new Request(url, { method: "POST", headers: { "content-length": String(300 * 1024 * 1024) }, body: new FormData() });
    const form = vi.spyOn(request, "formData");
    expect((await POST(request)).status).toBe(413);
    expect(form).not.toHaveBeenCalled(); expectNoProfileWork();
  });

  it("rejects an undeclared (chunked) upload that passes the archive limit while reading", async () => {
    vi.stubEnv("NODE_ENV", "test");
    // A body that declares no content-length and never ends below the limit.
    let produced = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced > 300 * 1024 * 1024) return controller.close();
        produced += 8 * 1024 * 1024;
        controller.enqueue(new Uint8Array(8 * 1024 * 1024));
      },
    });
    const request = new Request(url, { method: "POST", body: stream, duplex: "half" } as never);
    const form = vi.spyOn(request, "formData");
    expect((await POST(request)).status).toBe(413);
    expect(form).not.toHaveBeenCalled(); expectNoProfileWork();
  });

  it("local owner validation still rejects missing upload and invalid backup selector", async () => {
    vi.stubEnv("NODE_ENV", "test");
    expect((await POST(new Request(url, { method: "POST", body: new FormData() }))).status).toBe(400);
    expect((await PUT(jsonRequest("PUT", { backup: 42 }))).status).toBe(400);
    expectNoProfileWork();
  });
});
