"use client";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// Coalesce concurrent reads only; completed requests are removed immediately.
const inflightGets = new Map<string, Promise<unknown>>();

export function apiUrl(path: string, params?: Record<string, string | undefined>) {
  const url = new URL(path, window.location.origin);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

async function parseError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) return body.error;
  } catch {
    /* ignore */
  }
  return res.statusText || `HTTP ${res.status}`;
}

export async function getJson<T>(path: string, params?: Record<string, string | undefined>): Promise<T> {
  const url = apiUrl(path, params);
  const existing = inflightGets.get(url);
  if (existing) return existing as Promise<T>;

  const request = (async () => {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new ApiError(await parseError(res), res.status);
    return (await res.json()) as T;
  })();
  inflightGets.set(url, request);
  try {
    return await request;
  } finally {
    if (inflightGets.get(url) === request) inflightGets.delete(url);
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
  let signal = external;

  if (timeoutMs && timeoutMs > 0) {
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), timeoutMs);
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener("abort", () => controller.abort(), { once: true });
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
    if (!res.ok) throw new ApiError(await parseError(res), res.status);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ApiError("リクエストがタイムアウトまたはキャンセルされました", 408);
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
