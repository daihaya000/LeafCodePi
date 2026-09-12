/**
 * PATCH /api/agents/:name — enable/disable, set a subagent model/Effort/tools, or update a user agent.
 * GET    /api/agents/:name — read a user agent draft.
 * DELETE /api/agents/:name — delete a user agent.
 */
import { NextRequest, NextResponse } from "next/server";
import { reloadLiveSessionsContext } from "@/lib/pi/harness";
import {
  agentsErrorStatus,
  deleteAgent,
  listAgents,
  readUserAgent,
  setAgentEnabled,
  setAgentModel,
  setAgentThinking,
  setAgentTools,
  updateAgent,
  type AgentDraft,
  type AgentThinking,
} from "@/lib/agents";
import { isThinkingLevel } from "@/lib/thinking-levels";

/** `false` は pi-subagents の明示的な thinking 無効。`null` は設定解除。 */
function isThinkingInput(value: unknown): value is AgentThinking | null {
  return value === null || value === false || isThinkingLevel(value);
}

function scheduleLiveSessionsContextReload() {
  // Persisted settings can be returned immediately; a live session reload may wait for an active turn.
  setImmediate(() => {
    void reloadLiveSessionsContext().catch((error) => {
      console.warn("[agents] live session context reload failed", error);
    });
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ name: string }> };

export async function GET(_req: NextRequest, context: RouteContext) {
  const { name: rawName } = await context.params;
  let name: string;
  try {
    name = decodeURIComponent(rawName);
  } catch {
    return NextResponse.json({ error: "名前が不正です" }, { status: 400 });
  }
  try {
    const result = readUserAgent(name);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "エージェントの取得に失敗しました" },
      { status: agentsErrorStatus(error) },
    );
  }
}

export async function PATCH(req: NextRequest, context: RouteContext) {
  const { name: rawName } = await context.params;
  let name: string;
  try {
    name = decodeURIComponent(rawName);
  } catch {
    return NextResponse.json({ error: "名前が不正です" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエスト本文が不正です" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "リクエスト本文が不正です" }, { status: 400 });
  }
  const record = body as { enabled?: unknown } & Partial<AgentDraft>;
  if ("model" in record && record.model !== undefined && record.model !== null && typeof record.model !== "string") {
    return NextResponse.json({ error: "model は文字列または null が必要です" }, { status: 400 });
  }
  if ("thinking" in record && record.thinking !== undefined && !isThinkingInput(record.thinking)) {
    return NextResponse.json({ error: "effort が不正です" }, { status: 400 });
  }
  if ("tools" in record && record.tools !== undefined && (!Array.isArray(record.tools) || record.tools.some((tool) => typeof tool !== "string"))) {
    return NextResponse.json({ error: "tools は文字列配列が必要です" }, { status: 400 });
  }

  try {
    if (typeof record.enabled === "boolean") {
      // Toggle only (used by the switch).
      setAgentEnabled(name, record.enabled);
    } else if (!("systemPrompt" in record) && ("model" in record || "thinking" in record || "tools" in record)) {
      // 同時指定でも片方を黙って捨てない。
      if ("model" in record) setAgentModel(name, record.model ?? null);
      if ("thinking" in record) {
        setAgentThinking(name, isThinkingInput(record.thinking) ? record.thinking : null);
      }
      if ("tools" in record) setAgentTools(name, record.tools ?? []);
    } else {
      // Update the agent definition.
      if (typeof record.systemPrompt !== "string") {
        return NextResponse.json({ error: "systemPrompt が必要です" }, { status: 400 });
      }
      updateAgent({ ...(record as AgentDraft), name });
    }
    scheduleLiveSessionsContextReload();
    const listed = listAgents();
    return NextResponse.json({ ok: true, name, agents: listed.agents });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "エージェントの更新に失敗しました" },
      { status: agentsErrorStatus(error) },
    );
  }
}

export async function DELETE(_req: NextRequest, context: RouteContext) {
  const { name: rawName } = await context.params;
  let name: string;
  try {
    name = decodeURIComponent(rawName);
  } catch {
    return NextResponse.json({ error: "名前が不正です" }, { status: 400 });
  }
  try {
    const listed = deleteAgent(name);
    scheduleLiveSessionsContextReload();
    return NextResponse.json({ ok: true, agents: listed.agents });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "エージェントの削除に失敗しました" },
      { status: agentsErrorStatus(error) },
    );
  }
}
