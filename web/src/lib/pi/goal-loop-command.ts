import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** Stop controls must not enter the SDK's deferred prompt queue during settlement. */
export async function dispatchGoalLoopCommand(session: AgentSession, command: string): Promise<void> {
  const match = /^\/(goal-(?:pause|stop|complete))$/.exec(command);
  if (!match) {
    await session.prompt(command);
    return;
  }
  const runner = session.extensionRunner;
  const registered = runner?.getCommand(match[1]);
  if (!registered) {
    throw Object.assign(new Error("Goal Loop の操作コマンドが利用できません"), { status: 409 });
  }
  // This is the same public command/context pair used by SDK command dispatch,
  // without prompt()'s early return while agent_settled handlers are still running.
  await registered.handler("", runner.createCommandContext());
}
