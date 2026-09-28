import { bench, describe } from "vitest";
import type { ThroughputTiming } from "@/lib/token-throughput";
import { snapshotMessages } from "./snapshot-messages";

// Run from web/: npm exec -- vitest bench src/lib/pi/snapshot-messages.bench.ts --run
// Synthetic stress: 1,000 assistant tool calls and 1,000 users with retained timings.
// Measure the cached snapshot path, not cold projection.
const stored: unknown[] = [];
const throughput = new Map<number, ThroughputTiming>();
const started = new Map<string, number>();
const ended = new Map<string, number>();
const partialAll = new Map<string, string>();
for (let index = 0; index < 1_000; index++) {
  const timestamp = 10_000 + index * 10_000;
  const callId = `call-${index}`;
  stored.push(
    { role: "user", timestamp: timestamp - 500, content: "start" },
    { role: "assistant", timestamp, content: [
      { type: "text", text: "working" },
      { type: "toolCall", id: callId, name: "bash", arguments: {} },
    ] },
  );
  throughput.set(timestamp, {
    startedAtMs: timestamp,
    firstTokenAtMs: timestamp + 500,
    lastTokenAtMs: timestamp + 2_500,
    outputTokens: 50,
    charCount: 100,
  });
  started.set(callId, timestamp + 500);
  ended.set(callId, timestamp + 1_000);
  partialAll.set(callId, "partial output");
}
const partial = new Map([["call-999", "partial output"]]);
const session = {
  messages: stored,
  agent: { state: { streamingMessage: undefined } },
  sessionManager: { getLeafId: () => null, getBranch: () => [] },
} as unknown as Parameters<typeof snapshotMessages>[0];

const cases = [
  ["history only", () => snapshotMessages(session)],
  ["throughput only", () => snapshotMessages(session, throughput)],
  ["partial output only", () => snapshotMessages(session, undefined, undefined, undefined, partial)],
  ["partial output all", () => snapshotMessages(session, undefined, undefined, undefined, partialAll)],
  ["tool timing only", () => snapshotMessages(session, undefined, started, ended)],
  ["combined", () => snapshotMessages(session, throughput, started, ended, partial)],
] as const;
for (const [name, run] of cases) {
  if (run().length !== stored.length) throw new Error(`Unexpected row count: ${name}`);
}

describe("cached snapshotMessages (2,000 rows)", () => {
  for (const [name, run] of cases) {
    bench(name, () => { run(); }, { time: 250, warmupTime: 100 });
  }
});
