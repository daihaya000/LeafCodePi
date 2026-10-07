import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), fetch: vi.fn(), agents: [] as {
  options: { connect: { lookup: (host: string, settings: { all?: boolean }, callback: (...args: unknown[]) => void) => void } };
  destroy: ReturnType<typeof vi.fn>;
}[] }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("undici", () => ({
  fetch: mocks.fetch,
  Agent: class {
    destroy = vi.fn(async () => {});
    constructor(public options: typeof mocks.agents[number]["options"]) { mocks.agents.push(this); }
  },
}));
import { fetchPublicWebBytes, isPublicWebAddress } from "./public-web-fetch";
beforeEach(() => {
  mocks.lookup.mockReset().mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  mocks.fetch.mockReset();
  mocks.agents.length = 0;
});
it.each(["127.0.0.1", "10.1.2.3", "100.127.32.3", "169.254.169.254", "172.16.1.2", "192.168.1.2", "0.0.0.0", "192.0.2.1", "198.18.0.1", "224.0.0.1", "255.255.255.255", "::1", "::", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "64:ff9b::7f00:1", "2001:db8::1", "2002:7f00:1::", "3fff::1"])("blocks non-public address %s", (address) => {
  expect(isPublicWebAddress(address)).toBe(false);
});
it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"])("accepts global address %s", (address) => {
  expect(isPublicWebAddress(address)).toBe(true);
});
it.each(["http://127.1/", "http://0x7f000001/", "http://2130706433/", "http://localhost/", "https://service.internal/", "http://[::ffff:127.0.0.1]/", "https://user:pass@example.com", "file:///tmp/private", "https://example.com:8443/"])("never connects for unsafe URL %s", async (url) => {
  await expect(fetchPublicWebBytes(url, { accept: "text/html", maxBytes: 256 })).rejects.toThrow();
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(mocks.lookup).not.toHaveBeenCalled();
});
it("rejects private/mixed DNS answers before opening a connection", async () => {
  mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]);
  await expect(fetchPublicWebBytes("https://example.com", { accept: "text/html", maxBytes: 256 })).rejects.toThrow("DNS");
  expect(mocks.fetch).not.toHaveBeenCalled();
});
it("pins approved DNS addresses, suppresses implicit redirects and destroys its agent", async () => {
  mocks.fetch.mockResolvedValue(new Response("<head>preview</head>", { headers: { "content-type": "text/html" } }));
  const result = await fetchPublicWebBytes("https://example.com/#fragment", { accept: "text/html", maxBytes: 256 });
  expect(result.url).toBe("https://example.com/");
  const callback = vi.fn();
  mocks.agents[0].options.connect.lookup("example.com", {}, callback);
  expect(callback).toHaveBeenLastCalledWith(null, "8.8.8.8", 4);
  mocks.agents[0].options.connect.lookup("example.com", { all: true }, callback);
  expect(callback).toHaveBeenLastCalledWith(null, [{ address: "8.8.8.8", family: 4 }]);
  expect(mocks.lookup).toHaveBeenCalledOnce();
  expect(mocks.fetch.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  expect(mocks.fetch.mock.calls[0][1].headers).not.toHaveProperty("cookie");
  expect(mocks.fetch.mock.calls[0][1].headers).not.toHaveProperty("authorization");
  expect(mocks.agents[0].destroy).toHaveBeenCalledOnce();
});
it("blocks a redirect into private infrastructure and limits public redirect chains", async () => {
  mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/" } }));
  await expect(fetchPublicWebBytes("https://example.com", { accept: "text/html", maxBytes: 256 })).rejects.toThrow("Non-public");
  expect(mocks.fetch).toHaveBeenCalledOnce();
  mocks.fetch.mockImplementation(async () => new Response(null, { status: 302, headers: { location: "/again" } }));
  await expect(fetchPublicWebBytes("https://example.com", { accept: "text/html", maxBytes: 256 })).rejects.toThrow("Redirect limit");
  expect(mocks.fetch).toHaveBeenCalledTimes(5);
  expect(mocks.agents.every((agent) => agent.destroy.mock.calls.length === 1)).toBe(true);
});
it("caps HTML prefixes but rejects oversized image bodies, including missing length headers", async () => {
  mocks.fetch.mockResolvedValueOnce(new Response("abcdefghijklmnopqrstuvwxyz", { headers: { "content-length": "999" } }));
  expect((await fetchPublicWebBytes("https://example.com", { accept: "text/html", maxBytes: 8, prefix: true })).bytes.toString()).toBe("abcdefgh");
  mocks.fetch.mockResolvedValueOnce(new Response("abcdefghijklmnopqrstuvwxyz"));
  await expect(fetchPublicWebBytes("https://example.com", { accept: "image/*", maxBytes: 8 })).rejects.toThrow("too large");
});
it("does not consume login/token destinations reached via metadata redirects", async () => {
  mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://example.com/invite/one-time?token=private" } }));
  await expect(fetchPublicWebBytes("https://example.com", { accept: "text/html", maxBytes: 256, noSensitiveLinks: true })).rejects.toThrow("Sensitive");
  expect(mocks.fetch).toHaveBeenCalledOnce();
});
it("honors an already aborted request without DNS or network access", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(fetchPublicWebBytes("https://example.com", { accept: "text/html", maxBytes: 8, signal: controller.signal })).rejects.toThrow();
  expect(mocks.lookup).not.toHaveBeenCalled();
  expect(mocks.fetch).not.toHaveBeenCalled();
});
