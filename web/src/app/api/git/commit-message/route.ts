import { NextRequest, NextResponse } from "next/server";
import { isAbsolutePath } from "@/lib/paths";
import { suggestCommitMessage } from "@/lib/commit-message";
import { getSetting } from "@/lib/pi/web-settings";
import {
  GENERATION_FALLBACK_MODEL_SETTING_KEY,
  GENERATION_MODEL_SETTING_KEY,
} from "@/lib/generation-model-key";
import {
  buildDirectGenerationCandidates,
  generateDirectTextWithFallbackResult,
  parseDirectModel,
  parseDirectModelKey,
} from "@/lib/direct-generation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REQUEST_CHARS = 300_000;
const MAX_DIFF_CHARS_PER_FILE = 4_000;
const MAX_FILES = 50;
const DIRECT_CACHE_TTL_MS = 10_000;

type CachedMessage = {
  expiresAt: number;
  message: string;
  model: { providerID: string; modelID: string };
};

const directMessageCache = new Map<string, CachedMessage>();

type NormalizedFile = {
  path: string;
  untracked: boolean;
  additions: number;
  deletions: number;
  binary: boolean;
  diff: string;
};

type InputFile = {
  path?: unknown;
  untracked?: unknown;
  additions?: unknown;
  deletions?: unknown;
  binary?: unknown;
  hunks?: unknown;
};

function finiteCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(100_000, Math.floor(value))
    : 0;
}

function normalizeHunks(value: unknown): string {
  if (!Array.isArray(value)) return "";
  let output = "";
  for (const hunk of value.slice(0, 20)) {
    if (!hunk || typeof hunk !== "object") continue;
    const record = hunk as { header?: unknown; lines?: unknown };
    if (typeof record.header === "string") output += `${record.header.slice(0, 200)}\n`;
    if (!Array.isArray(record.lines)) continue;
    for (const line of record.lines.slice(0, 300)) {
      if (!line || typeof line !== "object") continue;
      const row = line as { t?: unknown; text?: unknown };
      const marker = row.t === "+" || row.t === "-" ? row.t : " ";
      const text = typeof row.text === "string" ? row.text.slice(0, 500) : "";
      output += `${marker}${text}\n`;
      if (output.length >= MAX_DIFF_CHARS_PER_FILE) return output.slice(0, MAX_DIFF_CHARS_PER_FILE);
    }
  }
  return output.slice(0, MAX_DIFF_CHARS_PER_FILE);
}

function normalizeFiles(value: unknown): NormalizedFile[] {
  if (!Array.isArray(value)) return [];
  const files: NormalizedFile[] = [];
  for (const file of value.slice(0, MAX_FILES)) {
    if (!file || typeof file !== "object") continue;
    const input = file as InputFile;
    if (
      typeof input.path !== "string" ||
      input.path.length === 0 ||
      input.path.length > 500 ||
      /[\u0000-\u001f\u007f]/.test(input.path)
    ) {
      continue;
    }
    files.push({
      path: input.path,
      untracked: input.untracked === true,
      additions: finiteCount(input.additions),
      deletions: finiteCount(input.deletions),
      binary: input.binary === true,
      diff: normalizeHunks(input.hunks),
    });
  }
  return files;
}

function generatedCommitLine(value: string): string {
  const line = value
    .replace(/^```(?:text|plain)?\s*/i, "")
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part && !part.startsWith("```"));
  return (line ?? "").replace(/^[`\"']+|[`\"']+$/g, "").trim().slice(0, 200);
}

function directPrompt(files: NormalizedFile[]): string {
  return files
    .map((file) => {
      const status = file.untracked ? "new" : "modified";
      const stats = `+${file.additions}/-${file.deletions}`;
      const diff = file.binary ? "[binary]" : file.diff || "[diff unavailable]";
      return `### ${status} ${file.path} (${stats})\n${diff}`;
    })
    .join("\n\n");
}

function isSimpleChange(files: NormalizedFile[]): boolean {
  if (files.length !== 1) return false;
  const [file] = files;
  return !file.binary && file.additions + file.deletions <= 3 && file.diff.length <= 1_000;
}

export async function POST(req: NextRequest) {
  const raw = await req.text().catch(() => "");
  if (raw.length > MAX_REQUEST_CHARS) {
    return NextResponse.json({ error: "request body is too large" }, { status: 413 });
  }
  const body = (() => {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  })();
  const directory = typeof body?.directory === "string" ? body.directory : "";
  if (!directory || !isAbsolutePath(directory)) {
    return NextResponse.json({ error: "directory is required" }, { status: 400 });
  }
  const files = normalizeFiles(body?.files);
  if (files.length === 0) {
    return NextResponse.json({ error: "files are required" }, { status: 400 });
  }

  if (isSimpleChange(files)) {
    const message = suggestCommitMessage(files);
    if (message) return NextResponse.json({ message, source: "fallback", model: null });
  }

  const configuredModel = parseDirectModelKey(getSetting(GENERATION_MODEL_SETTING_KEY));
  const primaryModel = configuredModel ?? parseDirectModel(body?.model);
  const fallbackModel = parseDirectModelKey(getSetting(GENERATION_FALLBACK_MODEL_SETTING_KEY));
  const candidates = buildDirectGenerationCandidates({
    primary: primaryModel,
    fallback: fallbackModel,
  });
  const cacheKey = JSON.stringify({ directory, files, candidates });
  const cached = directMessageCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json({ message: cached.message, source: "direct", model: cached.model });
  }
  if (cached) directMessageCache.delete(cacheKey);

  let warning: string | undefined;
  if (candidates.length > 0) {
    try {
      const generated = await generateDirectTextWithFallbackResult({
        candidates,
        system:
          "あなたはGitコミットメッセージ作成者です。差分だけを根拠に、日本語の短い命令形コミットメッセージを1行だけ返してください。説明、引用符、コードブロック、接頭辞は不要です。",
        prompt: directPrompt(files),
        maxTokens: 64,
        temperature: 0.1,
        timeoutMs: candidates[0].model.providerID === "llama-server" ? 30_000 : 60_000,
      });
      const message = generatedCommitLine(generated.text);
      if (message) {
        if (directMessageCache.size >= 100) directMessageCache.clear();
        directMessageCache.set(cacheKey, {
          expiresAt: Date.now() + DIRECT_CACHE_TTL_MS,
          message,
          model: generated.model,
        });
        return NextResponse.json({ message, source: "direct", model: generated.model });
      }
      warning = "AI生成の応答が空だったため、ファイル情報から生成しました";
    } catch (error) {
      const reason = error instanceof Error ? error.message : "直接生成に失敗しました";
      warning = `AI生成に失敗したため、ファイル情報から生成しました: ${reason}`;
      console.warn("[LeafCodePi] direct commit-message generation failed:", reason);
    }
  }

  const message = suggestCommitMessage(files);
  if (!message) {
    return NextResponse.json({ error: "could not suggest a message" }, { status: 400 });
  }
  return NextResponse.json({ message, source: "fallback", model: null, ...(warning ? { warning } : {}) });
}
