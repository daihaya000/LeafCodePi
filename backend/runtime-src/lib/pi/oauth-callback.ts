import { request } from "node:http";

export type OAuthCallbackTarget = {
  url: string;
  state: string | null;
};

function loopbackUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      !url.port || url.port === "0" ||
      url.username || url.password || url.hash
    ) return null;
    return url;
  } catch {
    return null;
  }
}

/** Only a callback advertised by the running provider can become a relay target. */
export function getOAuthCallbackTarget(authUrl: string): OAuthCallbackTarget | null {
  try {
    const auth = new URL(authUrl);
    if (!["http:", "https:"].includes(auth.protocol)) return null;
    const callbacks = [
      ...auth.searchParams.getAll("redirect_uri"),
      ...auth.searchParams.getAll("callback_url"),
    ];
    if (callbacks.length !== 1 || auth.searchParams.getAll("state").length > 1) return null;
    const callback = loopbackUrl(callbacks[0]);
    return callback ? { url: callback.href, state: auth.searchParams.get("state") } : null;
  } catch {
    return null;
  }
}

function invalidCallback(): Error {
  return Object.assign(new Error("認証開始時と一致する戻り先URL全体を貼り付けてください"), { status: 400 });
}

export function validateOAuthCallback(target: OAuthCallbackTarget, input: string): URL {
  if (input.length > 16384) throw invalidCallback();
  const expected = loopbackUrl(target.url);
  const actual = loopbackUrl(input.trim());
  if (!expected || !actual || actual.origin !== expected.origin || actual.pathname !== expected.pathname) {
    throw invalidCallback();
  }
  for (const key of new Set(expected.searchParams.keys())) {
    const values = expected.searchParams.getAll(key);
    if (JSON.stringify(actual.searchParams.getAll(key)) !== JSON.stringify(values)) throw invalidCallback();
  }
  // Duplicate fields have ambiguous semantics across OAuth implementations.
  for (const key of ["code", "state", "error"]) {
    if (actual.searchParams.getAll(key).length > 1) throw invalidCallback();
  }
  if (
    !actual.searchParams.get("code") || actual.searchParams.has("error") ||
    (target.state !== null && actual.searchParams.get("state") !== target.state)
  ) throw invalidCallback();
  return actual;
}

function callbackRelayFailure(code?: string): Error {
  return Object.assign(
    new Error("認証の戻り先へ接続できませんでした。認証を開始し直してください"),
    { status: 502, ...(code ? { code } : {}) },
  );
}

function relayToLoopbackHost(url: URL, hostname: string, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const fail = () => reject(callbackRelayFailure());
    const req = request({
      hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: "GET",
      agent: false,
      headers: { Host: url.host },
      signal,
    }, (res) => {
      res.resume();
      res.on("error", fail);
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve();
        else fail();
      });
    });
    req.on("error", (error: NodeJS.ErrnoException) => reject(callbackRelayFailure(error.code)));
    req.end();
  });
}

/** No DNS, environment proxy, redirects, or response body is used by this relay. */
export async function forwardOAuthCallback(
  target: OAuthCallbackTarget,
  input: string,
  signal: AbortSignal,
): Promise<void> {
  const url = validateOAuthCallback(target, input);
  const relaySignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  const hosts = url.hostname === "localhost"
    ? ["127.0.0.1", "::1"]
    : [url.hostname === "[::1]" ? "::1" : "127.0.0.1"];

  for (let index = 0; index < hosts.length; index += 1) {
    try {
      await relayToLoopbackHost(url, hosts[index], relaySignal);
      return;
    } catch (error) {
      const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
      if (url.hostname === "localhost" && index === 0 && code === "ECONNREFUSED") continue;
      throw error;
    }
  }
}
