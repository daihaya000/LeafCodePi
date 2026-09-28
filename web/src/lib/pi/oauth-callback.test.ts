import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { forwardOAuthCallback, getOAuthCallbackTarget, validateOAuthCallback } from "./oauth-callback";

const target = { url: "http://127.0.0.1:1456/oauth/callback", state: "test-state" };
const callback = `${target.url}?code=test-code&state=test-state`;
const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

async function serve(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/oauth/callback`;
}

describe("OAuth callback target", () => {
  it.each(["redirect_uri", "callback_url"])("extracts only the provider's %s", (key) => {
    expect(getOAuthCallbackTarget(`https://example.test/auth?${key}=${encodeURIComponent(target.url)}&state=test-state`)).toEqual(target);
  });

  it.each([
    "https://example.test/callback",
    "http://192.168.1.1:1456/callback",
    "http://localhost.example.test:1456/callback",
    "http://user:pass@127.0.0.1:1456/callback",
    "http://127.0.0.1/callback",
    "http://127.0.0.1:0/callback",
    "http://127.0.0.1:1456/callback#fragment",
    "file:///callback",
  ])("does not enable relay for %s", (url) => {
    expect(getOAuthCallbackTarget(`https://example.test/auth?redirect_uri=${encodeURIComponent(url)}`)).toBeNull();
  });

  it("rejects missing/ambiguous callback and state parameters", () => {
    expect(getOAuthCallbackTarget("not a URL")).toBeNull();
    expect(getOAuthCallbackTarget("https://example.test/device")).toBeNull();
    expect(getOAuthCallbackTarget(`https://example.test/?redirect_uri=${target.url}&callback_url=${target.url}`)).toBeNull();
    expect(getOAuthCallbackTarget(`https://example.test/?redirect_uri=${target.url}&state=a&state=b`)).toBeNull();
  });
});

describe("OAuth callback validation", () => {
  it("accepts a full matching URL, including surrounding whitespace", () => {
    expect(validateOAuthCallback(target, ` ${callback} `).href).toBe(callback);
  });

  it.each([
    "test-code",
    callback.replace("1456", "1457"),
    callback.replace("/oauth/callback", "/other"),
    callback.replace("127.0.0.1", "localhost"),
    callback.replace("127.0.0.1", "example.test"),
    callback.replace("test-state", "wrong-state"),
    callback.replace("&state=test-state", ""),
    callback.replace("code=test-code", "error=access_denied"),
    `${callback}&code=other`,
    `${callback}&state=other`,
    `${callback}#fragment`,
    "x".repeat(16385),
  ])("rejects mismatched or ambiguous callback %#", (input) => {
    expect(() => validateOAuthCallback(target, input)).toThrow(expect.objectContaining({ status: 400 }));
  });

  it("preserves provider-specific fixed query parameters", () => {
    const fixed = { ...target, url: `${target.url}?flow=one&flow=two` };
    expect(() => validateOAuthCallback(fixed, callback)).toThrow();
    expect(validateOAuthCallback(fixed, `${callback}&flow=one&flow=two`).pathname).toBe("/oauth/callback");
  });
});

describe("OAuth loopback relay", () => {
  it("delivers the callback on the host without returning the body", async () => {
    let received = "";
    const url = await serve((req, res) => {
      received = req.url ?? "";
      res.end("private provider response");
    });
    await expect(forwardOAuthCallback({ url, state: "test-state" }, `${url}?code=test-code&state=test-state`, new AbortController().signal)).resolves.toBeUndefined();
    expect(received).toBe("/oauth/callback?code=test-code&state=test-state");
  });

  it("pins localhost to loopback without DNS resolution", async () => {
    const url = (await serve((_req, res) => res.end("ok"))).replace("127.0.0.1", "localhost");
    await expect(forwardOAuthCallback({ url, state: null }, `${url}?code=test-code`, new AbortController().signal)).resolves.toBeUndefined();
  });

  it.each([302, 400, 500])("rejects HTTP %s without following redirects or exposing secrets", async (status) => {
    const url = await serve((_req, res) => {
      res.writeHead(status, { Location: "http://example.test/secret" });
      res.end("private response");
    });
    const error = await forwardOAuthCallback({ url, state: null }, `${url}?code=private-code`, new AbortController().signal).catch((error: unknown) => error);
    expect(error).toMatchObject({ status: 502 });
    expect(String(error)).not.toMatch(/private|example\.test|code=/);
  });

  it("cancels an in-flight request instead of leaving a waiting relay", async () => {
    let started!: () => void;
    const received = new Promise<void>((resolve) => { started = resolve; });
    const url = await serve(() => { started(); });
    const abort = new AbortController();
    const pending = forwardOAuthCallback({ url, state: null }, `${url}?code=test-code`, abort.signal);
    const rejection = expect(pending).rejects.toMatchObject({ status: 502 });
    await received;
    abort.abort();
    await rejection;
  });

  it("rejects cancellation without contacting the callback", async () => {
    const handler = vi.fn((_req, res) => res.end("ok"));
    const url = await serve(handler);
    const abort = new AbortController();
    abort.abort();
    await expect(forwardOAuthCallback({ url, state: null }, `${url}?code=test-code`, abort.signal)).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });
});
