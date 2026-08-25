import { existsSync, statSync } from "node:fs";
import { NextRequest, NextResponse } from "next/server";
import { getProject, listTasks } from "@/lib/store";
import { getSetting } from "@/lib/pi/web-settings";
import {
  GENERATION_FALLBACK_MODEL_EFFORT_SETTING_KEY,
  GENERATION_FALLBACK_MODEL_SETTING_KEY,
  GENERATION_MODEL_EFFORT_SETTING_KEY,
  GENERATION_MODEL_SETTING_KEY,
} from "@/lib/generation-model-key";
import {
  buildDirectGenerationCandidates,
  generateDirectTextWithFallbackResult,
  parseDirectModel,
  parseDirectModelKey,
} from "@/lib/direct-generation";
import { gitBranchRefs, gitDiff, gitLogGraph, gitStatus } from "@/lib/git";
import { isAbsolutePath } from "@/lib/paths";
import {
  formatRepoSnapshotForPrompt,
  NEXT_TASK_COMMIT_MAX_COUNT,
  NEXT_TASK_SYSTEM_INSTRUCTION,
  parseSuggestions,
  sanitizePreviousSuggestions,
  type RepoSnapshot,
} from "@/lib/direct-generation-text";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REQUEST_CHARS = 80_000;

function errorResponse(error: unknown): NextResponse {
  const status =
    typeof error === "object" && error && "status" in error && typeof error.status === "number"
      ? error.status
      : 502;
  return NextResponse.json(
    { error: error instanceof Error ? error.message : "次のタスクの生成に失敗しました" },
    { status },
  );
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const raw = await req.text().catch(() => "");
  if (raw.length > MAX_REQUEST_CHARS) {
    return NextResponse.json({ error: "request body is too large" }, { status: 413 });
  }
  const body = (() => {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  })();
  const { id } = await params;
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: "プロジェクトが見つかりません" }, { status: 404 });
  let validDirectory = false;
  try {
    validDirectory = isAbsolutePath(project.rootPath) && existsSync(project.rootPath) && statSync(project.rootPath).isDirectory();
  } catch {
    validDirectory = false;
  }
  if (!validDirectory) {
    return NextResponse.json({ error: "プロジェクトフォルダが見つかりません" }, { status: 400 });
  }

  const [status, diff, log, branch] = await Promise.all([
    gitStatus(project.rootPath).catch(() => ""),
    gitDiff(project.rootPath).catch(() => ""),
    gitLogGraph(project.rootPath, NEXT_TASK_COMMIT_MAX_COUNT)
      .then(({ commits }) => commits.map(({ shortHash, subject }) => ({ shortHash, subject })))
      .catch(() => []),
    gitBranchRefs(project.rootPath)
      .then(({ currentBranch }) => currentBranch)
      .catch(() => null),
  ]);
  const recentTasks = listTasks(true)
    .filter((task) => task.projectId === project.id && task.status !== "archived")
    .slice(0, 10)
    .map((task) => task.title);
  const snapshot: RepoSnapshot = {
    projectName: project.name,
    currentBranch: branch,
    status,
    diff,
    commits: log,
    recentTasks,
  };
  const previousSuggestions = sanitizePreviousSuggestions(body.previousSuggestions);
  const prompt = formatRepoSnapshotForPrompt(snapshot, previousSuggestions);
  if (!prompt) {
    return NextResponse.json({ error: "リポジトリに提案可能な状態がありません" }, { status: 400 });
  }
  const configuredModel = parseDirectModelKey(getSetting(GENERATION_MODEL_SETTING_KEY));
  const primaryModel = configuredModel ?? parseDirectModel(body.model);
  const fallbackModel = parseDirectModelKey(getSetting(GENERATION_FALLBACK_MODEL_SETTING_KEY));
  const candidates = buildDirectGenerationCandidates({
    primary: primaryModel,
    primaryEffort: configuredModel
      ? getSetting(GENERATION_MODEL_EFFORT_SETTING_KEY) || undefined
      : undefined,
    fallback: fallbackModel,
    fallbackEffort: fallbackModel
      ? getSetting(GENERATION_FALLBACK_MODEL_EFFORT_SETTING_KEY) || undefined
      : undefined,
  });
  if (candidates.length === 0) return NextResponse.json({ error: "生成モデルが設定されていません" }, { status: 400 });

  try {
    const generated = await generateDirectTextWithFallbackResult({
      candidates,
      system: NEXT_TASK_SYSTEM_INSTRUCTION,
      prompt,
      maxTokens: 180,
      temperature: 0.2,
      timeoutMs: 60_000,
    });
    const suggestion = generated.text.trim();
    const suggestions = parseSuggestions({ suggestion });
    if (suggestions.length === 0) return errorResponse(new Error("提案の応答が空です"));
    return NextResponse.json({ suggestion: suggestions[0], suggestions, source: "direct", model: generated.model });
  } catch (error) {
    return errorResponse(error);
  }
}
