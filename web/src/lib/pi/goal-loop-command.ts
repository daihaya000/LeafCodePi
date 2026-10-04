import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { isGoalLoopLiveStatus } from "@/lib/goal-loop-settings";

/** A command handler can refuse without throwing; verify the resulting durable state. */
export function isGoalLoopCommandApplied(action: "start" | "resume" | "pause" | "stop" | "complete", loop: { status?: unknown } | null): boolean {
  if (!loop) return false;
  if (action === "start" || action === "resume") return isGoalLoopLiveStatus(typeof loop.status === "string" ? loop.status : null);
  if (action === "pause") return loop.status === "paused";
  if (action === "complete") return loop.status === "completed";
  return loop.status === "stopped" || loop.status === "completed";
}

/** Encodes the restart-only instruction so it cannot be split by command parsing. */
export function buildGoalLoopResumeCommand(input: { maxTurns?: number; restartPrompt?: string }): string {
  let command = "/goal-resume";
  if (input.maxTurns !== undefined) command += ` --turns ${Math.trunc(input.maxTurns)}`;
  const restartPrompt = input.restartPrompt?.trim();
  if (restartPrompt) {
    command += ` --restart-prompt ${Buffer.from(restartPrompt, "utf8").toString("base64url")}`;
  }
  return command;
}

/** Goal commands must not enter the SDK's deferred prompt queue during settlement. */
export async function dispatchGoalLoopCommand(session: AgentSession, command: string): Promise<void> {
  const match = /^\/(goal-(?:start|resume|pause|stop|complete))(?:\s+([\s\S]*))?$/.exec(command);
  if (!match) {
    await session.prompt(command);
    return;
  }
  const runner = session.extensionRunner;
  const registered = runner?.getCommand?.(match[1]);
  if (!registered) {
    throw Object.assign(new Error("Goal Loop の操作コマンドが利用できません"), { status: 409 });
  }
  // This is the same public command/context pair used by SDK command dispatch,
  // without prompt()'s early return while agent_settled handlers are still running.
  await registered.handler(match[2] ?? "", runner.createCommandContext());
}
