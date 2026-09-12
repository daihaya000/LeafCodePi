/**
 * GET /api/agents — list pi-subagents agents (builtin + user) with ON/OFF state.
 * POST /api/agents — create a user agent definition (~/.pi/agent/agents/<name>.md).
 */
import { NextResponse } from "next/server";
import { agentsErrorStatus, createAgent, listAgents, type AgentDraft } from "@/lib/agents";
import { reloadLiveSessionsContext } from "@/lib/pi/harness";
import { isThinkingLevel } from "@/lib/thinking-levels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function scheduleLiveSessionsContextReload() {
  // Persisted settings can be returned immediately; a live session reload may wait for an active turn.
  setImmediate(() => {
    void reloadLiveSessionsContext().catch((error) => {
      console.warn("[agents] live session context reload failed", error);
    });
  });
}

export async function GET() {
  try {
    return NextResponse.json(listAgents());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "エージェント一覧の取得に失敗しました" },
      { status: agentsErrorStatus(error) },
    );
  }
}

export async function POST(request: Request) {
  try {
    const raw = await request.json().catch(() => null);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return NextResponse.json({ error: "リクエスト本文が不正です" }, { status: 400 });
    }
    const body = raw as Partial<AgentDraft>;
    if (typeof body.name !== "string" || !body.name.trim()) {
      return NextResponse.json({ error: "name が必要です" }, { status: 400 });
    }
    if (typeof body.systemPrompt !== "string") {
      return NextResponse.json({ error: "systemPrompt が必要です" }, { status: 400 });
    }
    if (body.description !== undefined && typeof body.description !== "string") {
      return NextResponse.json({ error: "description は文字列が必要です" }, { status: 400 });
    }
    if (body.model !== undefined && typeof body.model !== "string") {
      return NextResponse.json({ error: "model は文字列が必要です" }, { status: 400 });
    }
    if (body.thinking !== undefined && body.thinking !== false && !isThinkingLevel(body.thinking)) {
      return NextResponse.json({ error: "thinking が不正です" }, { status: 400 });
    }
    if (body.systemPromptMode !== undefined && body.systemPromptMode !== "replace" && body.systemPromptMode !== "append") {
      return NextResponse.json({ error: "systemPromptMode が不正です" }, { status: 400 });
    }
    if (body.async !== undefined && typeof body.async !== "boolean") {
      return NextResponse.json({ error: "async はbooleanが必要です" }, { status: 400 });
    }
    if (body.inheritProjectContext !== undefined && typeof body.inheritProjectContext !== "boolean") {
      return NextResponse.json({ error: "inheritProjectContext はbooleanが必要です" }, { status: 400 });
    }
    if (body.inheritSkills !== undefined && typeof body.inheritSkills !== "boolean") {
      return NextResponse.json({ error: "inheritSkills はbooleanが必要です" }, { status: 400 });
    }
    const aliases = body.aliases as unknown;
    if (
      aliases !== undefined &&
      (!Array.isArray(aliases) || aliases.some((alias) => typeof alias !== "string"))
    ) {
      return NextResponse.json({ error: "aliases は文字列配列が必要です" }, { status: 400 });
    }
    const tools = body.tools as unknown;
    if (
      tools !== undefined &&
      (!Array.isArray(tools) || tools.some((tool) => typeof tool !== "string"))
    ) {
      return NextResponse.json({ error: "tools は文字列配列が必要です" }, { status: 400 });
    }
    const fallbackModels = body.fallbackModels as unknown;
    if (
      fallbackModels !== undefined &&
      (!Array.isArray(fallbackModels) || fallbackModels.some((model) => typeof model !== "string"))
    ) {
      return NextResponse.json({ error: "fallbackModels は文字列配列が必要です" }, { status: 400 });
    }
    const result = createAgent(normalize(body as AgentDraft));
    scheduleLiveSessionsContextReload();
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "エージェントの作成に失敗しました" },
      { status: agentsErrorStatus(error) },
    );
  }
}

function normalize(draft: AgentDraft): AgentDraft {
  return {
    ...draft,
    name: draft.name.trim(),
    description: draft.description?.trim() || undefined,
    aliases: toArray(draft.aliases),
    // Preserve explicit empty allowlists; toArray([]) would erase deny-all into "use defaults".
    tools: draft.tools === undefined
      ? undefined
      : [...new Set(draft.tools.map((tool) => tool.trim()).filter(Boolean))],
    fallbackModels: toArray(draft.fallbackModels),
    systemPrompt: draft.systemPrompt,
  };
}

function toArray(values: string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  const list = values.map((v) => v.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}
