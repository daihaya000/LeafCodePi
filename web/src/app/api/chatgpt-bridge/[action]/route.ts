import { NextRequest, NextResponse } from "next/server";
import { resolveHostControlUrl } from "@/lib/host-control";
import {
  chatGptBridgePath,
  isSafeChatGptIteration,
  isSafeChatGptProjectId,
  isSafeChatGptPublicTaskId,
  type ChatGptAdvisoryMessageKind,
  type ChatGptBridgeAction,
  type ChatGptExitStatus,
} from "@/lib/chatgpt-bridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIONS = new Set<ChatGptBridgeAction>([
  "setup",
  "start",
  "pair",
  "verify",
  "stop",
  "disconnect",
  "message",
  "record",
  "enabled",
]);

const MESSAGE_KINDS = new Set<ChatGptAdvisoryMessageKind>(["init", "executed"]);
const EXIT_STATUSES = new Set<ChatGptExitStatus>(["ok", "failed", "blocked"]);

function noStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function parseAction(raw: string): ChatGptBridgeAction | null {
  return ACTIONS.has(raw as ChatGptBridgeAction) ? (raw as ChatGptBridgeAction) : null;
}

function invalid(message: string): NextResponse {
  return noStore(NextResponse.json({ ok: false, error: message }, { status: 400 }));
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ action: string }> },
): Promise<NextResponse> {
  const action = parseAction((await params).action);
  if (!action) return noStore(NextResponse.json({ ok: false, error: "unknown action" }, { status: 404 }));

  const contentLength = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > 16_384) return invalid("request is too large");
  const raw = await req.json().catch(() => null);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return invalid("request must be an object");
  const body = raw as Record<string, unknown>;

  if (action === "enabled") {
    if (typeof body.enabled !== "boolean" || Object.keys(body).some((key) => key !== "enabled")) {
      return invalid("enabled must be a boolean");
    }
  } else {
    const allowedKeys = action === "disconnect"
      ? new Set(["projectId", "deleteState"])
      : action === "message"
        ? new Set(["projectId", "publicTaskId", "iteration", "kind", "goal"])
        : action === "record"
          ? new Set(["projectId", "publicTaskId", "iteration", "tests", "exitStatus"])
          : new Set(["projectId"]);
    if (Object.keys(body).some((key) => !allowedKeys.has(key))) return invalid("unsupported request fields");
    if (!isSafeChatGptProjectId(body.projectId)) return invalid("projectId is invalid");
    if (action === "disconnect" && body.deleteState !== undefined && typeof body.deleteState !== "boolean") {
      return invalid("deleteState must be a boolean");
    }
    if (action === "message" || action === "record") {
      if (!isSafeChatGptPublicTaskId(body.publicTaskId)) return invalid("publicTaskId is invalid");
      if (!isSafeChatGptIteration(body.iteration)) return invalid("iteration is invalid");
    }
    if (action === "message") {
      if (!MESSAGE_KINDS.has(body.kind as ChatGptAdvisoryMessageKind)) return invalid("message kind is invalid");
      if (body.goal !== undefined && (typeof body.goal !== "string" || body.goal.length > 600)) {
        return invalid("goal is invalid");
      }
    }
    if (action === "record") {
      if (!EXIT_STATUSES.has(body.exitStatus as ChatGptExitStatus)) return invalid("exitStatus is invalid");
      if (body.tests !== undefined && body.tests !== null && (typeof body.tests !== "string" || body.tests.length > 1_000)) {
        return invalid("tests is invalid");
      }
    }
  }

  let forwarded: Record<string, unknown>;
  if (action === "enabled") {
    forwarded = { enabled: body.enabled };
  } else {
    forwarded = { projectId: body.projectId };
    if (action === "disconnect" && body.deleteState === true) forwarded.deleteState = true;
    if (action === "message") {
      forwarded.publicTaskId = body.publicTaskId;
      forwarded.iteration = body.iteration;
      forwarded.kind = body.kind;
      if (body.goal !== undefined) forwarded.goal = body.goal;
    }
    if (action === "record") {
      forwarded.publicTaskId = body.publicTaskId;
      forwarded.iteration = body.iteration;
      forwarded.exitStatus = body.exitStatus;
      if (body.tests !== undefined) forwarded.tests = body.tests;
    }
  }

  try {
    const response = await fetch(`${resolveHostControlUrl()}${chatGptBridgePath(action)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(forwarded),
      cache: "no-store",
      signal: AbortSignal.timeout(action === "setup" ? 95_000 : 10_000),
    });
    const data = await response.json().catch(() => ({ ok: false, error: "invalid host response" }));
    return noStore(NextResponse.json(data, { status: response.status || 502 }));
  } catch {
    return noStore(NextResponse.json({ ok: false, state: "unavailable", error: "ホストに接続できません" }, { status: 503 }));
  }
}
