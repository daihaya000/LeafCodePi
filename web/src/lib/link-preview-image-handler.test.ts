import { beforeEach, expect, it, vi } from "vitest";
const image = vi.hoisted(() => vi.fn());
vi.mock("@/lib/link-preview", () => ({ getLinkPreviewImage: image }));
import { GET } from "@backend-runtime/json-business/handlers/link-preview/image/route";
beforeEach(() => image.mockReset());
it("reads only an opaque Backend cache ID and returns a private binary envelope", async () => {
  image.mockResolvedValue({ bytes: Buffer.from([137,80,78,71,13,10,26,10]), mime: "image/png" });
  const id = "a".repeat(32);
  const response = await GET(new Request("http://localhost/api/link-preview/image?id="+id+"&url=PRIVATE"));
  expect(image).toHaveBeenCalledWith(id); expect(await response.json()).toEqual({ image: { contentType: "image/png", base64: "iVBORw0KGgo=" } });
});
it("missing/expired IDs are quietly unavailable", async () => {
  image.mockResolvedValue(null); expect((await GET(new Request("http://localhost/api/link-preview/image?id=bad"))).status).toBe(404);
});
