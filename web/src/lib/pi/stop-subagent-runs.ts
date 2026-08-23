import type { SubagentRunDto } from "@/lib/types";

/** Stop every currently running child while allowing one failed stop to not block the rest. */
export async function stopRunningSubagentRuns(
  runs: readonly Pick<SubagentRunDto, "runId" | "status">[],
  stop: (runId: string) => Promise<void>,
): Promise<{ attempted: string[]; failed: string[] }> {
  // A long-running child can be labelled stale by the artifact poller after
  // ten minutes without output even though its process is still alive.
  const active = runs.filter((run) => run.status === "running" || run.status === "stale");
  const results = await Promise.allSettled(active.map((run) => stop(run.runId)));
  return {
    attempted: active.map((run) => run.runId),
    failed: active.flatMap((run, index) => results[index]?.status === "rejected" ? [run.runId] : []),
  };
}
