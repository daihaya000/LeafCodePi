// Only known read-only built-ins are cancellable. Shell, wrappers, delegated work,
// writes and unknown/custom tools must reach the SDK's normal steering boundary.
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

export type ImmediateSteerState = {
  isStreaming: boolean;
  isCompacting: boolean;
  blocked: boolean;
  pendingMessageCount: number;
  promptQueueDepth: number;
  activeToolNames: readonly string[];
};

export function canInterruptForSteer(state: ImmediateSteerState): boolean {
  return state.isStreaming && !state.isCompacting && !state.blocked
    && state.pendingMessageCount === 0 && state.promptQueueDepth <= 1
    && state.activeToolNames.every((name) => READ_ONLY_TOOLS.has(name));
}
