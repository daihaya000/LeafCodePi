import { NextRequest, NextResponse } from "next/server";
import { resolveHostControlUrl } from "@/lib/host-control";
import { isSafeChatGptProjectId } from "@/lib/chatgpt-bridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIONS = new Set(["setup", "open", "verify", "stop", "cleanup", "enabled", "project"]);

function noStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function invalid(message: string): NextResponse {
  return noStore(NextResponse.json({ ok: false, error: message }, { status: 400 }));
}

async function handle(
  req: NextRequest,
  { params }: { params: Promise<{ action: string }> },
): Promise<NextResponse> {
  const action = (await params).action;
  if (!ACTIONS.has(action)) {
    return noStore(NextResponse.json({ ok: false, error: "unknown action" }, { status: 404 }));
  }

  const contentLength = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > 16_384) return invalid("request is too large");
  const raw = await req.json().catch(() => null);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return invalid("request must be an object");
  const body = raw as Record<string, unknown>;

  if (action === "enabled") {
    if (typeof body.enabled !== "boolean" || Object.keys(body).some((key) => key !== "enabled")) {
      return invalid("enabled must be a boolean");
    }
  } else if (action === "project") {
    if (!isSafeChatGptProjectId(body.projectId) || Object.keys(body).some((key) => key !== "projectId")) {
      return invalid("projectId is invalid");
    }
  } else if (action === "cleanup") {
    if (Object.keys(body).some((key) => key !== "deleteProfile") ||
      (body.deleteProfile !== undefined && typeof body.deleteProfile !== "boolean")) {
      return invalid("deleteProfile must be a boolean");
    }
  } else if (action === "setup") {
    if (!isSafeChatGptProjectId(body.projectId) || Object.keys(body).some((key) => key !== "projectId")) {
      return invalid("projectId is invalid");
    }
  } else if (Object.keys(body).length > 0) {
    return invalid("unsupported request fields");
  }

  const forwarded: Record<string, unknown> = {};
  if (action === "setup" || action === "project") forwarded.projectId = body.projectId;
  if (action === "enabled") forwarded.enabled = body.enabled;
  if (action === "cleanup" && body.deleteProfile === true) forwarded.deleteProfile = true;

  try {
    const response = await fetch(`${resolveHostControlUrl()}/chatgpt-advisor/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(forwarded),
      cache: "no-store",
      signal: AbortSignal.timeout(action === "setup" ? 120_000 : 10_000),
    });
    const data = await response.json().catch(() => ({ ok: false, error: "invalid host response" }));
    return noStore(NextResponse.json(data, { status: response.status || 502 }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return noStore(NextResponse.json({ ok: false, state: "unavailable", error: message }, { status: 503 }));
  }
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ action: string }> },
): Promise<NextResponse> {
  return handle(req, context);
}
