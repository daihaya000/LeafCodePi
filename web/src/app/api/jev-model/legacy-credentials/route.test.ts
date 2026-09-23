import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, GET } from "./route";

const mocks = vi.hoisted(() => ({ list: vi.fn(), remove: vi.fn() }));
vi.mock("@/lib/pi/jev-model-config", () => ({
  listLegacyJevCredentials: mocks.list,
  deleteLegacyJevCredential: mocks.remove,
}));
const id = `jev-compatible-${"a".repeat(64)}`;
const request = (body: unknown, headers: Record<string, string> = {}) => new NextRequest("http://localhost/api/jev-model/legacy-credentials", {
  method: "DELETE", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue([{ providerId: id, label: "example.com", active: false }]);
  mocks.remove.mockResolvedValue(undefined);
});

describe("legacy Jev credential API", () => {
  it("returns only credential metadata and deletes the exact legacy id", async () => {
    expect(await (await GET()).json()).toEqual({ credentials: [{ providerId: id, label: "example.com", active: false }] });
    expect((await DELETE(request({ providerId: id }))).status).toBe(200);
    expect(mocks.remove).toHaveBeenCalledOnce();
    expect(mocks.remove).toHaveBeenCalledWith(id);
  });

  it("rejects cross-origin requests and unrelated credential ids", async () => {
    expect((await DELETE(request({ providerId: id }, { origin: "https://other.example" }))).status).toBe(403);
    expect((await DELETE(request({ providerId: "typesafe" }))).status).toBe(400);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
