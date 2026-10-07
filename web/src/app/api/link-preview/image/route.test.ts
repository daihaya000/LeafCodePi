import { beforeEach, expect, it, vi } from "vitest";
const image = vi.hoisted(() => vi.fn());
vi.mock("@/lib/link-preview", () => ({ getLinkPreviewImage: image }));
import { GET } from "./route";
beforeEach(() => image.mockReset());
it("delivers registered thumbnails with private caching and same-origin/nosniff headers", async () => {
  image.mockResolvedValue({ bytes: Buffer.from([1, 2, 3]), mime: "image/png" });
  const id = "a".repeat(32);
  const response = await GET(new Request(`http://localhost/api/link-preview/image?id=${id}`));
  expect(image).toHaveBeenCalledWith(id);
  expect(response.status).toBe(200);
  expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(response.headers.get("content-length")).toBe("3");
  expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
});
it("returns a quiet unavailable image for missing/expired IDs", async () => {
  image.mockResolvedValue(null);
  const response = await GET(new Request("http://localhost/api/link-preview/image?id=bad"));
  expect(response.status).toBe(404);
  expect(response.headers.get("cache-control")).toBe("no-store");
});
