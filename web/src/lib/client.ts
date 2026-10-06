"use client";

export class ApiError extends Error {
  status: number;
  code?: string;
  reason?: string;
  constructor(message: string, status: number, details?: { code?: string; reason?: string }) {
    super(message);
    this.status = status;
    this.code = details?.code;
    this.reason = details?.reason;
  }
}

// Coalesce concurrent reads only; completed requests are removed immediately.
const inflightGets = new Map<string, Promise<unknown>>();

/**
 * Last ETag-bearing body per URL, kept as text so every caller still gets a fresh object (callers
 * may mutate what they receive). Polls send If-None-Match and reuse this on an empty 304.
 */
const etagBodies = new Map<string, { etag: string; text: string }>();
const ETAG_BODY_LIMIT = 24;

function rememberEtagBody(url: string, etag: string, text: string) {
  etagBodies.delete(url);
  etagBodies.set(url, { etag, text });
  while (etagBodies.size > ETAG_BODY_LIMIT) {
    const oldest = etagBodies.keys().next().value;
    if (oldest === undefined) break;
    etagBodies.delete(oldest);
  }
}

/** Test hook: forget remembered ETag bodies. */
export function clearEtagBodiesForTest() {
  etagBodies.clear();
}

export function apiUrl(path: string, params?: Record<string, string | undefined>) {
  const url = new URL(path, window.location.origin);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

async function parseError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { error?: unknown; code?: unknown; reason?: unknown };
    return new ApiError(typeof body?.error === "string" ? body.error : res.statusText || `HTTP ${res.status}`, res.status, {
      ...(typeof body?.code === "string" ? { code: body.code } : {}),
      ...(typeof body?.reason === "string" ? { reason: body.reason } : {}),
    });
  } catch {
    return new ApiError(res.statusText || `HTTP ${res.status}`, res.status);
  }
}

export async function getJson<T>(
  path: string,
  params?: Record<string, string | undefined>,
  options?: { coalesce?: boolean; signal?: AbortSignal },
): Promise<T> {
  const url = apiUrl(path, params);
  const coalesce = options?.coalesce !== false && options?.signal === undefined;
  const existing = coalesce ? inflightGets.get(url) : undefined;
  if (existing) return existing as Promise<T>;

  const request = (async () => {
    const remembered = etagBodies.get(url);
    const res = await fetch(url, {
      cache: "no-store",
      ...(remembered ? { headers: { "if-none-match": remembered.etag } } : {}),
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    if (res.status === 304 && remembered) {
      // LRU touch: a list polled every few seconds must not be evicted by one-off reads.
      rememberEtagBody(url, remembered.etag, remembered.text);
      return JSON.parse(remembered.text) as T;
    }
    if (!res.ok) throw await parseError(res);
    const etag = res.headers?.get?.("etag");
    if (!etag) {
      if (remembered) etagBodies.delete(url);
      return (await res.json()) as T;
    }
    const text = await res.text();
    const parsed = JSON.parse(text) as T;
    rememberEtagBody(url, etag, text);
    return parsed;
  })();
  if (coalesce) inflightGets.set(url, request);
  try {
    return await request;
  } finally {
    if (coalesce && inflightGets.get(url) === request) {
      inflightGets.delete(url);
    }
  }
}

export async function sendJson<T>(
  path: string,
  body: unknown,
  method: "POST" | "PATCH" | "PUT" | "DELETE" = "POST",
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<T> {
  const timeoutMs = options?.timeoutMs;
  const external = options?.signal;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let removeExternalAbortListener: (() => void) | undefined;
  let signal = external;

  if (timeoutMs && timeoutMs > 0) {
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), timeoutMs);
    if (external) {
      const abortFromExternal = () => controller.abort();
      if (external.aborted) controller.abort();
      else {
        external.addEventListener("abort", abortFromExternal, { once: true });
        removeExternalAbortListener = () =>
          external.removeEventListener("abort", abortFromExternal);
      }
    }
    signal = controller.signal;
  }

  try {
    const res = await fetch(apiUrl(path), {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw await parseError(res);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ApiError("リクエストがタイムアウトまたはキャンセルされました", 408);
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    removeExternalAbortListener?.();
  }
}
