import { createHash } from "node:crypto";

/**
 * JSON responses for polled reads, with conditional GET.
 *
 * The sidebar polls the task list (hundreds of KB), projects and bots every 2s while any task is
 * working, and the bodies rarely change between polls. A weak ETag over the serialized body lets
 * the client send `If-None-Match` and receive an empty 304 instead of the same payload again, which
 * is what remote (Tailscale/mobile) clients pay for. The body is still built on every request; only
 * the transfer is skipped.
 */
export function jsonEtag(json: string): string {
  return `W/"${createHash("sha1").update(json).digest("base64url")}"`;
}

function ifNoneMatchIncludes(header: string | null, etag: string): boolean {
  if (!header) return false;
  const bare = etag.replace(/^W\//, "");
  return header.split(",").some((candidate) => {
    const value = candidate.trim();
    return value === "*" || value.replace(/^W\//, "") === bare;
  });
}

export function etagJsonResponse(
  req: Pick<Request, "headers"> | undefined,
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const json = JSON.stringify(body);
  const etag = jsonEtag(json);
  const headers: Record<string, string> = {
    ...init.headers,
    ETag: etag,
    // The client revalidates explicitly; nothing should serve this list from a cache unasked.
    "Cache-Control": "private, no-cache",
  };
  if ((init.status ?? 200) === 200 && ifNoneMatchIncludes(req?.headers?.get("if-none-match") ?? null, etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(json, {
    status: init.status ?? 200,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}
