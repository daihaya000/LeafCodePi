/** One-shot, branch-aware self-resume reservations. No subprocess or external callback. */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  RESUME_ENTRY_TYPE,
  resumeReservationFromBranch,
  type ResumeReservation,
} from "../../shared/session-resume.ts";

export { RESUME_ENTRY_TYPE, type ResumeReservation } from "../../shared/session-resume.ts";
export const RESUME_CANCEL_COMMAND = "session-resume-cancel";
const MAX_DELAY_SECONDS = 24 * 60 * 60;
const MAX_MESSAGE_CHARS = 4_000;
const BUSY_RETRY_MS = 1_000;

type ResumeParams = {
  action: "schedule" | "status" | "cancel";
  afterSeconds?: number;
  at?: string;
  message?: string;
};
type Runtime = {
  key: string;
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  reservation?: ResumeReservation;
  timer?: ReturnType<typeof setTimeout>;
  disposed: boolean;
};
// Pi uses fresh jiti imports on reload. Ownership must survive that module boundary.
const REGISTRY_KEY = Symbol.for("leafcode-session-resume.runtimes");
const registryStore = globalThis as typeof globalThis & { [REGISTRY_KEY]?: Map<string, Runtime> };
const runtimes = registryStore[REGISTRY_KEY] ??= new Map<string, Runtime>();

function runtimeKey(ctx: ExtensionContext): string {
  return JSON.stringify([ctx.cwd, ctx.sessionManager.getSessionId()]);
}
function ownsRuntime(runtime: Runtime): boolean {
  return !runtime.disposed && runtimes.get(runtime.key) === runtime && runtimeKey(runtime.ctx) === runtime.key;
}
function clearTimer(runtime: Runtime): void {
  if (runtime.timer) clearTimeout(runtime.timer);
  runtime.timer = undefined;
}
function dispose(runtime: Runtime): void {
  clearTimer(runtime);
  runtime.disposed = true;
  if (runtimes.get(runtime.key) === runtime) runtimes.delete(runtime.key);
}

function readReservation(ctx: ExtensionContext): ResumeReservation | undefined {
  return resumeReservationFromBranch(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionId());
}
function updateStatus(runtime: Runtime): void {
  runtime.ctx.ui.setStatus(RESUME_ENTRY_TYPE, runtime.reservation?.status === "scheduled"
    ? `再開予約: ${runtime.reservation.at}` : undefined);
}
function save(runtime: Runtime, reservation: ResumeReservation): void {
  runtime.pi.appendEntry(RESUME_ENTRY_TYPE, reservation);
  clearTimer(runtime);
  runtime.reservation = reservation;
  updateStatus(runtime);
}
function cancel(runtime: Runtime): boolean {
  if (runtime.reservation?.status !== "scheduled") return false;
  // Stop the timer even if persistence fails: operator Stop must never launch work.
  clearTimer(runtime);
  runtime.reservation = { ...runtime.reservation, status: "cancelled" };
  updateStatus(runtime);
  runtime.pi.appendEntry(RESUME_ENTRY_TYPE, runtime.reservation);
  return true;
}
function arm(runtime: Runtime, delay?: number): void {
  clearTimer(runtime);
  if (!ownsRuntime(runtime) || runtime.reservation?.status !== "scheduled") return;
  const remaining = Date.parse(runtime.reservation.at) - Date.now();
  runtime.timer = setTimeout(() => fire(runtime), delay ?? Math.max(0, Math.min(MAX_DELAY_SECONDS * 1_000, remaining)));
  // A reservation must not keep print-mode Pi (or a shutting-down host) alive.
  runtime.timer.unref?.();
}
function fire(runtime: Runtime): void {
  runtime.timer = undefined;
  if (!ownsRuntime(runtime) || runtime.reservation?.status !== "scheduled") return;
  try {
    const latest = readReservation(runtime.ctx);
    if (latest?.id !== runtime.reservation.id || latest.status !== "scheduled") {
      runtime.reservation = latest;
      updateStatus(runtime);
      arm(runtime);
      return;
    }
    if (Date.parse(latest.at) > Date.now()) {
      arm(runtime);
      return;
    }
    // Never interrupt a productive turn, compaction, or queued user input.
    if (!runtime.ctx.isIdle() || runtime.ctx.hasPendingMessages() || !runtime.pi.getActiveTools().includes("session_resume")) {
      arm(runtime, BUSY_RETRY_MS);
      return;
    }
    // Persist consumption before sending: reload/late shutdown cannot deliver twice.
    save(runtime, { ...latest, status: "fired" });
    runtime.pi.sendMessage({
      customType: "leafcode-session-resume-trigger",
      content: [
        `予約したセッション再開（${latest.id}）。現在時刻: ${new Date().toISOString()}。`,
        "これは自分で予約した継続であり、新しいユーザー承認ではない。現在の状態を確認してから必要な作業だけを続ける。完了済みなら再予約しない。",
        latest.message,
      ].join("\n"),
      display: true,
      details: { id: latest.id, scheduledAt: latest.at, uiPrompt: `【予約再開】\n${latest.message}` },
    }, { triggerTurn: true, deliverAs: "followUp" });
  } catch (error) {
    clearTimer(runtime);
    if (runtime.reservation) runtime.reservation = { ...runtime.reservation, status: "failed", error: String(error) };
    updateStatus(runtime);
    console.warn("[session-resume] 再開予約の実行に失敗:", error);
  }
}

function createReservation(params: ResumeParams, ctx: ExtensionContext): ResumeReservation {
  if (typeof params.message !== "string" || !params.message.trim() || params.message.length > MAX_MESSAGE_CHARS) {
    throw new Error(`scheduleには再開時のmessageが必要（1〜${MAX_MESSAGE_CHARS}文字）。`);
  }
  if ((params.afterSeconds !== undefined) === (params.at !== undefined)) {
    throw new Error("afterSeconds または at のどちらか一方を指定する。");
  }
  const now = Date.now();
  let due: number;
  if (params.afterSeconds !== undefined) {
    if (!Number.isInteger(params.afterSeconds) || params.afterSeconds < 1 || params.afterSeconds > MAX_DELAY_SECONDS) {
      throw new Error(`afterSecondsは1〜${MAX_DELAY_SECONDS}の整数。`);
    }
    due = now + params.afterSeconds * 1_000;
  } else {
    if (typeof params.at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(params.at)) {
      throw new Error("atはタイムゾーン付きISO日時を指定する。");
    }
    due = Date.parse(params.at);
    if (!Number.isFinite(due) || due - now < 1_000 || due - now > MAX_DELAY_SECONDS * 1_000) {
      throw new Error("atは1秒後〜24時間後の日時を指定する。");
    }
  }
  return {
    version: 1, sessionId: ctx.sessionManager.getSessionId(), id: randomUUID(),
    createdAt: new Date(now).toISOString(), at: new Date(due).toISOString(),
    message: params.message.trim(), status: "scheduled",
  };
}

export default function sessionResumeExtension(pi: ExtensionAPI): void {
  let runtime: Runtime | undefined;
  const restore = (ctx: ExtensionContext) => {
    if (runtime) dispose(runtime);
    const key = runtimeKey(ctx);
    const previous = runtimes.get(key);
    if (previous) dispose(previous);
    runtime = { key, pi, ctx, disposed: false, reservation: readReservation(ctx) };
    runtimes.set(key, runtime);
    updateStatus(runtime);
    arm(runtime);
  };
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", () => { if (runtime) dispose(runtime); });
  pi.on("agent_settled", () => { if (runtime && ownsRuntime(runtime)) arm(runtime); });
  pi.on("input", (event) => {
    // A new user task supersedes old reminders; steering the current task does not.
    if (runtime && ownsRuntime(runtime) && event.source !== "extension" && !event.streamingBehavior) cancel(runtime);
  });
  pi.on("agent_end", (event) => {
    const last = event.messages.filter((message) => message.role === "assistant").at(-1);
    if (runtime && ownsRuntime(runtime) && last?.role === "assistant" && last.stopReason === "aborted") cancel(runtime);
  });
  pi.registerCommand(RESUME_CANCEL_COMMAND, {
    description: "自セッションの再開予約を取消（モデルを起動しない）",
    handler: async (_args, ctx) => {
      if (runtime && ownsRuntime(runtime) && runtime.key === runtimeKey(ctx)) cancel(runtime);
    },
  });
  pi.registerTool({
    name: "session_resume",
    label: "Session Resume",
    description: "Schedule a one-shot continuation of THIS session and return immediately. Use when shell/background work or a temporarily unavailable service needs a later check. schedule requires message and exactly one of afterSeconds (1–86400) or at (ISO with timezone, within 24h). One pending reservation per session; schedule replaces it. status inspects it; cancel removes it. Waits for the session to be idle, survives reload/resume of the same session, and does not keep a stopped Pi process alive. No recurring loop, subprocess, or new permission grant.",
    promptGuidelines: ["Before ending a turn with unfinished background work and no completion subscription, use session_resume to reserve the next check instead of promising automatic continuation without a trigger. Prefer subagent_wait nonBlocking for an exact managed run. Cancel reservations when no longer needed; never rearm after completion."],
    // Plain JSON Schema avoids adding a runtime dependency to this bundled extension.
    parameters: {
      type: "object", additionalProperties: false, required: ["action"],
      properties: {
        action: { type: "string", enum: ["schedule", "status", "cancel"] },
        afterSeconds: { type: "integer", minimum: 1, maximum: MAX_DELAY_SECONDS },
        at: { type: "string", description: "ISO timestamp with timezone, 1 second to 24 hours in the future." },
        message: { type: "string", minLength: 1, maxLength: MAX_MESSAGE_CHARS, description: "What to check or continue on resumption. Not a new user approval." },
      },
    },
    async execute(_id, args, signal, _onUpdate, ctx) {
      try {
        if (!runtime || !ownsRuntime(runtime) || runtime.key !== runtimeKey(ctx)) throw new Error("現在のセッションは再開予約を受け付けられない。");
        if (signal?.aborted) throw new Error("中断済みの呼び出しでは予約を変更できない。");
        const params = args as unknown as ResumeParams;
        let text: string;
        if (params.action === "schedule") {
          const reservation = createReservation(params, ctx);
          save(runtime, reservation);
          arm(runtime);
          text = `${reservation.at} にこのセッションの再開を予約した。待機を続けず、ユーザーへ戻してよい。`;
        } else if (params.action === "cancel") {
          text = cancel(runtime) ? "再開予約を取り消した。" : "有効な再開予約はない。";
        } else if (params.action === "status") {
          text = runtime.reservation ? `${runtime.reservation.status}: ${runtime.reservation.at}` : "再開予約はない。";
        } else throw new Error("actionはschedule / status / cancelのいずれか。");
        return { content: [{ type: "text", text }], details: { reservation: runtime.reservation ?? null } };
      } catch (error) {
        return { content: [{ type: "text", text: String(error) }], details: { error: String(error) }, isError: true };
      }
    },
  });
}
