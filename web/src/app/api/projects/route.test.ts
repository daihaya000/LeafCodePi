import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ addProject: vi.fn(), archiveProjectAndStopTasks: vi.fn(), destroyProject: vi.fn(), getProjects: vi.fn(), jsonError: vi.fn((error: unknown) => ({ error: error instanceof Error ? error.message : String(error), status: 500 })), migrateProject: vi.fn(), patchProject: vi.fn(), restoreProject: vi.fn() }));
vi.mock("@/lib/pi/harness", () => mocks);
import { GET, POST, DELETE, PATCH } from "@backend-runtime/json-business/handlers/projects/route";
const request = (method: string, body?: unknown, query = "") => new NextRequest(`http://localhost/api/projects${query}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
beforeEach(() => { vi.clearAllMocks(); });
describe("Backend Project lifecycle handlers", () => {
  it("reads icon URLs/ETag and creates a registered project", async () => {
    mocks.getProjects.mockReturnValue([{ id: "p1", icon: "data:image/png;base64,YQ==" }]);
    const list = await GET(request("GET")); expect(list.status).toBe(200); expect((await list.json()).projects[0].icon).toMatch(/^\/api\/projects\/p1\/icon\?v=/); expect(mocks.getProjects).toHaveBeenCalledWith(false);
    mocks.addProject.mockReturnValue({ id: "p1", rootPath: "C:\\work" }); expect((await POST(request("POST", { rootPath: "C:\\work" }))).status).toBe(200); expect(mocks.addProject).toHaveBeenCalledWith("C:\\work");
  });
  it("dispatches archive/restore/move/delete only to this owner", async () => {
    mocks.archiveProjectAndStopTasks.mockResolvedValue({ id: "p1", archived: true }); mocks.restoreProject.mockReturnValue({ id: "p1", archived: false }); mocks.migrateProject.mockResolvedValue({ project: { id: "p1", rootPath: "C:\\moved" }, warning: "source cleanup pending" }); mocks.destroyProject.mockResolvedValue({ ok: true });
    expect((await PATCH(request("PATCH", { id: "p1", archived: true }))).status).toBe(200); expect(mocks.archiveProjectAndStopTasks).toHaveBeenCalledWith("p1");
    await PATCH(request("PATCH", { id: "p1", archived: false })); expect(mocks.restoreProject).toHaveBeenCalledWith("p1");
    const moved = await PATCH(request("PATCH", { id: "p1", destinationPath: "C:\\moved" })); expect(await moved.json()).toMatchObject({ warning: "source cleanup pending" }); expect(mocks.migrateProject).toHaveBeenCalledWith("p1", "C:\\moved");
    expect(await (await DELETE(request("DELETE", undefined, "?id=p1"))).json()).toEqual({ ok: true }); expect(mocks.destroyProject).toHaveBeenCalledWith("p1");
  });
  it.each(["image/x-icon", "image/vnd.microsoft.icon"])("keeps ICO icon compatibility (%s)", async mime => {
    const icon = `data:${mime};base64,AAABAAEAEBA=`; mocks.patchProject.mockReturnValue({ id: "p1", icon }); expect((await PATCH(request("PATCH", { id: "p1", icon }))).status).toBe(200); expect(mocks.patchProject).toHaveBeenCalledWith("p1", { icon });
  });
  it("retains icon colors/clear and refuses non-raster/overlarge icons", async () => {
    mocks.patchProject.mockReturnValue({ id: "p1", iconColor: "purple" }); await PATCH(request("PATCH", { id: "p1", iconColor: "purple" })); expect(mocks.patchProject).toHaveBeenCalledWith("p1", { iconColor: "purple" });
    await PATCH(request("PATCH", { id: "p1", icon: null })); expect(mocks.patchProject).toHaveBeenCalledWith("p1", { icon: null });
    for (const icon of ["data:image/svg+xml;base64,PHN2Zy8=", "data:image/png;base64," + "A".repeat(3000000)]) expect((await PATCH(request("PATCH", { id: "p1", icon }))).status).toBe(400);
  });
  it("validates body/ID/destination before any mutation", async () => {
    for (const body of [null, [], { rootPath: 1 }, { rootPath: "" }]) expect((await POST(request("POST", body))).status).toBe(400);
    for (const body of [null, { id: {} }, { id: "../p" }, { id: "p1", destinationPath: " " }, { id: "p1", iconColor: "magenta" }]) expect((await PATCH(request("PATCH", body))).status).toBe(400);
    expect((await DELETE(request("DELETE", undefined, "?id=..%2Fp"))).status).toBe(400); expect(mocks.addProject).not.toHaveBeenCalled(); expect(mocks.migrateProject).not.toHaveBeenCalled();
  });
});
