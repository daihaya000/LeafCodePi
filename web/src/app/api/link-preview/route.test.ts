import { beforeEach, expect, it, vi } from "vitest";
const preview = vi.hoisted(() => vi.fn());
vi.mock("@/lib/link-preview", () => ({ getLinkPreview: preview }));
import { POST } from "./route";
beforeEach(() => preview.mockReset().mockResolvedValue({ url: "https://example.com/", title: "Example" }));
it("accepts URLs in a bounded POST body without putting URL/query secrets in endpoint paths", async () => {
  const response = await POST(new Request("http://localhost/api/link-preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: "https://example.com/?view=public" }) }));
  expect(response.status).toBe(200);
  expect(preview).toHaveBeenCalledWith("https://example.com/?view=public");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});
it.each([null, {}, { url: "javascript:alert(1)" }, { url: "https://user:secret@example.com" }, { url: "http://example.com:8123/" }])("rejects invalid input without upstream access: %j", async (input) => {
  const response = await POST(new Request("http://localhost/api/link-preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }));
  expect(response.status).toBe(400);
  expect(preview).not.toHaveBeenCalled();
  expect(JSON.stringify(await response.json())).not.toContain("secret");
});
it("rejects non-JSON forms without upstream access", async () => {
  expect((await POST(new Request("http://localhost/api/link-preview", { method: "POST", body: JSON.stringify({ url: "https://example.com" }) }))).status).toBe(415);
  expect(preview).not.toHaveBeenCalled();
});
it("rejects malformed and oversized request bodies", async () => {
  expect((await POST(new Request("http://localhost/api/link-preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }))).status).toBe(400);
  expect((await POST(new Request("http://localhost/api/link-preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: "x".repeat(33 * 1024) }))).status).toBe(413);
  expect(preview).not.toHaveBeenCalled();
});
