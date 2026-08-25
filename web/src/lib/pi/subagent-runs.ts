import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SubagentRunDto } from "@/lib/types";
import { projectPiMessages } from "./messages";

/**
 * pi-subagents は子エージェント実行ごとに
 * `{artifactsDir}/{runId}_{agent}[_{index}]_transcript.jsonl` を追記する
 * （`createChildTranscriptWriter`）。1 行 1 レコードで、`recordType`
 * `message` は Pi の Message そのものを `message` に持つので、親タイムラインと
 * 同じ `projectPiMessages` で射影できる。
 *
 * artifactsDir は既定でセッションファイルと同じ階層の `subagent-artifacts`。
 * `artifactDir: "temp" | "project"` 設定時は temp / プロジェクト配下になる。
 */
const TRANSCRIPT_SUFFIX = "_transcript.jsonl";
/** ponytail: 末尾だけ読む。全文が必要になったらページングを足す。 */
const MAX_TRANSCRIPT_BYTES = 1_000_000;
/** 1 リクエストで返すラン数の上限（新しい順）。 */
const MAX_RUNS = 8;

type TranscriptRecord = {
  recordType?: unknown;
  runId?: unknown;
  agent?: unknown;
  childIndex?: unknown;
  ts?: unknown;
  toolName?: unknown;
  toolCallId?: unknown;
  message?: unknown;
  text?: unknown;
  role?: unknown;
  model?: unknown;
  provider?: unknown;
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export type ParsedTranscript = {
  runId?: string;
  agent?: string;
  index?: number;
  /** Pi Message 配列（`projectPiMessages` にそのまま渡せる）。 */
  rawMessages: unknown[];
  /** 未完了のツール名（tool_start に対応する tool_end が無いもの）。 */
  currentTool: string | null;
  provider?: string;
  model?: string;
  firstTsMs?: number;
  lastTsMs?: number;
  /** 先頭が切り落とされている（末尾読み）ときに true。 */
  truncated: boolean;
};

/** transcript JSONL テキストを 1 ラン分の情報に変換する。 */
export function parseSubagentTranscript(text: string, options?: { truncated?: boolean }): ParsedTranscript {
  const rawMessages: unknown[] = [];
  const openTools = new Map<string, string>();
  let runId: string | undefined;
  let agent: string | undefined;
  let index: number | undefined;
  let firstTsMs: number | undefined;
  let lastTsMs: number | undefined;
  let model: string | undefined;
  let provider: string | undefined;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: TranscriptRecord;
    try {
      record = JSON.parse(trimmed) as TranscriptRecord;
    } catch {
      continue; // 末尾読みで切れた行・書き込み途中の行は捨てる
    }
    runId ??= asString(record.runId);
    agent ??= asString(record.agent);
    if (index === undefined) index = asNumber(record.childIndex);
    const ts = asNumber(record.ts);
    if (ts !== undefined) {
      firstTsMs ??= ts;
      lastTsMs = ts;
    }

    if (record.recordType === "message" && isRecord(record.message)) {
      const message = { ...record.message };
      if (message.timestamp === undefined && ts !== undefined) message.timestamp = ts;
      rawMessages.push(message);
      if (asString(record.role) === "assistant") {
        model = asString(message.model) ?? asString(record.model) ?? model;
        provider = asString(message.provider) ?? asString(record.provider) ?? provider;
      }
      continue;
    }
    if (record.recordType === "tool_start") {
      const key = asString(record.toolCallId) ?? asString(record.toolName) ?? "";
      const name = asString(record.toolName);
      if (name) openTools.set(key, name);
      continue;
    }
    if (record.recordType === "tool_end") {
      const key = asString(record.toolCallId) ?? asString(record.toolName) ?? "";
      openTools.delete(key);
    }
  }

  const currentTool = [...openTools.values()].pop() ?? null;
  return {
    runId,
    agent,
    index,
    rawMessages,
    currentTool,
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    firstTsMs,
    lastTsMs,
    truncated: options?.truncated === true,
  };
}

export type RunStatusInput = {
  /** `{runId}_{agent}[_{index}]_meta.json` の内容（無ければ null）。 */
  meta: { exitCode?: unknown; error?: unknown; timedOut?: unknown } | null;
  lastActivityAtMs?: number;
  nowMs: number;
  /** 最終更新からこの時間を超えたら停止扱い。 */
  staleAfterMs?: number;
};

/** meta.json の有無と最終更新から実行状態を決める。 */
export function resolveRunStatus(input: RunStatusInput): SubagentRunDto["status"] {
  const { meta } = input;
  if (meta) {
    const exitCode = asNumber(meta.exitCode);
    if (meta.timedOut === true) return "error";
    if (asString(meta.error)) return "error";
    return exitCode === undefined || exitCode === 0 ? "completed" : "error";
  }
  const stale = input.staleAfterMs ?? 10 * 60_000;
  if (input.lastActivityAtMs !== undefined && input.nowMs - input.lastActivityAtMs > stale) {
    return "stale";
  }
  return "running";
}

/** transcript ファイル名から meta / output のパスを導く。 */
export function siblingArtifactPaths(transcriptPath: string): {
  metaPath: string;
  outputPath: string;
} {
  const base = transcriptPath.slice(0, -TRANSCRIPT_SUFFIX.length);
  return { metaPath: `${base}_meta.json`, outputPath: `${base}_output.md` };
}

/** 走査対象の artifacts ディレクトリ（存在するものだけ）。 */
export function subagentArtifactDirs(input: {
  sessionFile?: string | null;
  cwd?: string | null;
  tmpDir?: string;
  exists?: (dir: string) => boolean;
  readTmpEntries?: (tmpDir: string) => string[];
}): string[] {
  const exists = input.exists ?? ((dir: string) => fs.existsSync(dir));
  const dirs: string[] = [];
  if (input.sessionFile) {
    dirs.push(path.join(path.dirname(input.sessionFile), "subagent-artifacts"));
  }
  if (input.cwd) {
    dirs.push(path.join(input.cwd, ".pi", "subagents", "artifacts"));
  }
  const tmpDir = input.tmpDir ?? os.tmpdir();
  const readTmpEntries =
    input.readTmpEntries ??
    ((dir: string) => {
      try {
        return fs.readdirSync(dir);
      } catch {
        return [];
      }
    });
  for (const entry of readTmpEntries(tmpDir)) {
    if (!entry.startsWith("pi-subagents-")) continue;
    dirs.push(path.join(tmpDir, entry, "artifacts"));
  }
  return [...new Set(dirs)].filter((dir) => exists(dir));
}

function readMeta(metaPath: string): { exitCode?: unknown; error?: unknown; timedOut?: unknown } | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 巨大 transcript は末尾のみ読む（先頭の欠けた行はパーサが落とす）。 */
function readTranscriptTail(filePath: string, size: number): { text: string; truncated: boolean } {
  if (size <= MAX_TRANSCRIPT_BYTES) {
    return { text: fs.readFileSync(filePath, "utf-8"), truncated: false };
  }
  const handle = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(MAX_TRANSCRIPT_BYTES);
    fs.readSync(handle, buffer, 0, MAX_TRANSCRIPT_BYTES, size - MAX_TRANSCRIPT_BYTES);
    return { text: buffer.toString("utf-8"), truncated: true };
  } finally {
    fs.closeSync(handle);
  }
}

type TranscriptCacheEntry = {
  mtimeMs: number;
  size: number;
  parsed: ParsedTranscript;
  /** projectPiMessages の射影結果（キャッシュヒット時に再計算しない）。 */
  uiMessages: ReturnType<typeof projectPiMessages>;
};

/**
 * 2 秒間隔ポーリングは同じ transcript を繰り返し読む。transcript は追記専用
 * ファイルなので、mtime/size 不変時はパース（最大 1MB の行パース +
 * projectPiMessages 相当）をスキップする。
 */
const transcriptCache = new Map<string, TranscriptCacheEntry>();

/**
 * タスクのセッションに紐づくサブエージェント実行を新しい順に返す。
 * `since` はツール呼び出し開始時刻などの下限（ファイル更新時刻で判定）。
 */
export function listSubagentRuns(input: {
  sessionFile?: string | null;
  cwd?: string | null;
  sinceMs?: number;
  nowMs?: number;
  limit?: number;
}): SubagentRunDto[] {
  const nowMs = input.nowMs ?? Date.now();
  const limit = input.limit ?? MAX_RUNS;
  const candidates: { filePath: string; mtimeMs: number; size: number }[] = [];

  for (const dir of subagentArtifactDirs({ sessionFile: input.sessionFile, cwd: input.cwd })) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(TRANSCRIPT_SUFFIX)) continue;
      const filePath = path.join(dir, entry);
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
        if (input.sinceMs !== undefined && stat.mtimeMs < input.sinceMs) continue;
        candidates.push({ filePath, mtimeMs: stat.mtimeMs, size: stat.size });
      } catch {
        // 消えた/読めないファイルは無視
      }
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const runs: SubagentRunDto[] = [];
  for (const candidate of candidates.slice(0, limit)) {
    let parsed: ParsedTranscript;
    let uiMessages: ReturnType<typeof projectPiMessages>;
    try {
      const cached = transcriptCache.get(candidate.filePath);
      if (cached && cached.mtimeMs === candidate.mtimeMs && cached.size === candidate.size) {
        parsed = cached.parsed;
        uiMessages = cached.uiMessages;
      } else {
        const { text, truncated } = readTranscriptTail(candidate.filePath, candidate.size);
        parsed = parseSubagentTranscript(text, { truncated });
        uiMessages = projectPiMessages(parsed.rawMessages);
        transcriptCache.set(candidate.filePath, {
          mtimeMs: candidate.mtimeMs,
          size: candidate.size,
          parsed,
          uiMessages,
        });
      }
    } catch {
      transcriptCache.delete(candidate.filePath);
      continue;
    }
    const { metaPath } = siblingArtifactPaths(candidate.filePath);
    const meta = readMeta(metaPath);
    // 停止判定はファイル更新時刻を下限に取る（レコードの ts が欠けても誤判定しない）。
    const lastActivityAtMs = Math.max(parsed.lastTsMs ?? 0, candidate.mtimeMs);
    runs.push({
      runId: parsed.runId ?? path.basename(candidate.filePath, TRANSCRIPT_SUFFIX),
      agent: parsed.agent ?? "subagent",
      ...(parsed.index !== undefined ? { index: parsed.index } : {}),
      status: resolveRunStatus({ meta, lastActivityAtMs, nowMs }),
      startedAtMs: parsed.firstTsMs ?? candidate.mtimeMs,
      lastActivityAtMs,
      currentTool: parsed.currentTool,
      ...(parsed.model ? { model: parsed.model } : {}),
      ...(parsed.provider ? { provider: parsed.provider } : {}),
      truncated: parsed.truncated,
      messages: uiMessages,
    });
  }
  return runs;
}
