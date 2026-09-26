/**
 * LeafCode Loop Guard for Pi
 *
 * 同じツールを同じ引数で呼び、既に得た結果と同じ結果が続く（新しい情報のない呼び出しが続く）と、
 * 結果に警告を付け、さらに続けば呼び出しを止める。止めた後も繰り返すと実行を終了する。
 *
 * 誤検知を避けるための前提:
 * - 判定は「ツール名＋引数＋結果」の一致。結果が変われば新しい情報として数え直すので、
 *   状態が進むポーリングや、編集を挟んだテストの再実行は積み上がらない。
 * - 新しい入力（ユーザー送信、steer / follow-up、Goal Loop の各ターン、他拡張のメッセージ）、
 *   新しい実行の開始、compaction で数え直す。Goal Loop はターンごとに入力を送るため、
 *   ターンをまたいで同じ確認コマンドを実行しても積み上がらない。
 * - 待つためのツール（subagent_wait / wait_for）は数えない。
 */

import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** 既知の結果の繰り返しがこの回数続くと、結果に警告を付ける（同じ呼び出しだけなら4回目から）。 */
export const WARN_REPEATS = 3;
/** 既知の結果の繰り返しがこの回数続いた後、既に実行した呼び出しを止める（同じ呼び出しだけなら10回目）。 */
export const STOP_REPEATS = 8;
/** 直近の実行をこの件数まで覚え、A→B→A→B のような短い周期も検出する。 */
const WINDOW = 20;
/** 待機が目的のツール。繰り返しが本来の使い方なので数えない。 */
const WAIT_TOOLS = new Set(["subagent_wait", "wait_for"]);
const TAG = "[loop-guard]";

type ResultPart = { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };
type Execution = { call: string; outcome: string };
export type LoopGuardStop = { reason: string; terminate: boolean };

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

/** 引数のキー順に依存しない呼び出しの識別子。巨大な引数を保持しないようハッシュにする。 */
export function callIdentity(toolName: string, input: unknown): string {
  return createHash("sha256").update(`${toolName}\0${stableJson(input)}`).digest("hex");
}

function outcomeIdentity(call: string, content: readonly ResultPart[] | undefined, isError: boolean): string {
  const hash = createHash("sha256").update(call).update(isError ? "\0error" : "\0ok");
  for (const part of content ?? []) {
    if (part?.type === "text" && typeof part.text === "string") hash.update(`\0text\0${part.text}`);
    else if (part?.type === "image" && typeof part.data === "string") {
      hash.update(`\0image\0${String(part.mimeType)}\0${part.data}`);
    } else hash.update(`\0other\0${stableJson(part)}`);
  }
  return hash.digest("hex");
}

function warningText(repeats: number): string {
  const left = STOP_REPEATS - repeats;
  return `${TAG} 既に得た結果と同じ結果の呼び出しが${repeats}回続いています。` +
    "名前・パス・引数を一覧や前回の出力と照合し、前提を見直してください。" +
    "待機が目的なら、間隔を延ばすか、変化を確認できる方法に切り替えてください。" +
    (left > 0
      ? `あと${left}回続くと、同じ呼び出しを止めます。`
      : "次に同じ呼び出しを繰り返すと止めます。");
}

function stopText(repeats: number, terminate: boolean): string {
  return terminate
    ? `${TAG} 止めた後も同じ呼び出しを繰り返したため、この実行を終了しました（既に得た結果と同じ結果が${repeats}回連続）。`
    : `${TAG} 既に得た結果と同じ結果の呼び出しが${repeats}回続いたため、この呼び出しを止めました。` +
      "同じ呼び出しを繰り返さず、これまでの結果と前提（名前・パス・引数）を照合して原因を特定するか、状況をユーザーに報告してください。" +
      "もう一度繰り返すと、この実行を終了します。";
}

export class LoopGuard {
  private recent: Execution[] = [];
  private repeats = 0;
  private stops = 0;
  private readonly pending = new Map<string, string>();

  /** 新しい入力・実行開始・compaction の後は、それまでの結果を既知として扱わない。 */
  reset(): void {
    this.recent = [];
    this.repeats = 0;
    this.stops = 0;
    this.pending.clear();
  }

  /** This event precedes all tool_call handlers, including permission denials. */
  recordStart(toolCallId: string, toolName: string, input: unknown): void {
    if (!WAIT_TOOLS.has(toolName)) this.pending.set(toolCallId, callIdentity(toolName, input));
  }

  hasPending(toolCallId: string): boolean {
    return this.pending.has(toolCallId);
  }

  clearPending(): void {
    this.pending.clear();
  }

  /** Earlier blocking handlers can bypass our tool_call hook; bound that path too. */
  shouldAbortDeniedLoop(): boolean {
    return this.repeats >= STOP_REPEATS + 2;
  }

  /** 実行前: 止める呼び出しなら理由を返す。未実行の呼び出しは結果が分からないので止めない。 */
  beforeCall(toolCallId: string, toolName: string, input: unknown): LoopGuardStop | undefined {
    if (WAIT_TOOLS.has(toolName)) return undefined;
    const call = callIdentity(toolName, input);
    if (this.repeats < STOP_REPEATS || !this.recent.some((entry) => entry.call === call)) {
      // 後続の拡張が引数を書き換えても、結果を同じ呼び出しとして記録する。
      this.pending.set(toolCallId, call);
      return undefined;
    }
    // Our own diagnostic must not reset the streak when its result is emitted.
    this.pending.delete(toolCallId);
    const terminate = this.stops > 0;
    this.stops += 1;
    return { reason: stopText(this.repeats, terminate), terminate };
  }

  /** 実行後: 結果に付ける警告文を返す。 */
  afterCall(
    toolCallId: string,
    toolName: string,
    input: unknown,
    content: readonly ResultPart[] | undefined,
    isError: boolean,
  ): string | undefined {
    if (WAIT_TOOLS.has(toolName)) return undefined;
    const call = this.pending.get(toolCallId) ?? callIdentity(toolName, input);
    this.pending.delete(toolCallId);
    const outcome = outcomeIdentity(call, content, isError);
    // Compare with the latest observation for this call, not any older value.
    // A changing monitor may legitimately revisit a previous state.
    const previous = [...this.recent].reverse().find((entry) => entry.call === call);
    this.repeats = previous?.outcome === outcome ? this.repeats + 1 : 0;
    if (this.repeats === 0) this.stops = 0;
    this.recent.push({ call, outcome });
    if (this.recent.length > WINDOW) this.recent.shift();
    return this.repeats >= WARN_REPEATS ? warningText(this.repeats) : undefined;
  }
}

function notify(ctx: ExtensionContext, message: string): void {
  if (!ctx.hasUI) return;
  try {
    ctx.ui.notify(message, "warning");
  } catch {
    // The UI may already be gone; the tool result still carries the reason.
  }
}

export default function leafcodeLoopGuard(pi: ExtensionAPI): void {
  const guard = new LoopGuard();
  const reset = () => guard.reset();

  pi.on("session_start", reset);
  pi.on("agent_start", reset);
  pi.on("session_compact", reset);
  pi.on("session_shutdown", reset);
  pi.on("agent_end", () => guard.clearPending());
  pi.on("tool_execution_start", (event) => {
    guard.recordStart(event.toolCallId, event.toolName, event.args);
  });
  // Prompts, steer/follow-up, Goal Loop turns and other extensions' messages
  // all enter the run as user/custom messages: each one is new information.
  pi.on("message_start", (event) => {
    const role = (event.message as { role?: unknown }).role;
    if (role === "user" || role === "custom") guard.reset();
  });
  pi.on("tool_call", (event, ctx) => {
    const stop = guard.beforeCall(event.toolCallId, event.toolName, event.input);
    if (!stop) return undefined;
    notify(ctx, stop.terminate
      ? "同じ呼び出しの繰り返しが止まらないため、実行を終了しました。"
      : "同じ呼び出しが同じ結果で続いたため、呼び出しを止めました。");
    return { block: true, reason: stop.reason, terminate: stop.terminate };
  });
  pi.on("tool_result", (event) => {
    const warning = guard.afterCall(event.toolCallId, event.toolName, event.input, event.content, event.isError);
    // The WebUI cap spends its budget from the first block onwards.
    return warning ? { content: [{ type: "text" as const, text: warning }, ...event.content] } : undefined;
  });
  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "toolResult" || !guard.hasPending(message.toolCallId)) return;
    // Blocked/invalid calls skip tool_result, but still publish a toolResult message.
    let warning = guard.afterCall(message.toolCallId, message.toolName, undefined, message.content, message.isError);
    if (guard.shouldAbortDeniedLoop()) {
      warning = `${TAG} 拒否された同じ呼び出しの繰り返しを検知し、実行を中断しました。`;
      notify(ctx, warning);
      ctx.abort();
    }
    return warning ? {
      message: { ...message, content: [{ type: "text" as const, text: warning }, ...message.content] },
    } : undefined;
  });
}
