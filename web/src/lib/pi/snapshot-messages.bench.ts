import { bench, describe } from "vitest";
import type { ThroughputTiming } from "@/lib/token-throughput";
import { applyToolOutput, snapshotMessages } from "./snapshot-messages";
import { VersionedTimingMap } from "./versioned-timing-map";
import { VersionedThroughputMap } from "./versioned-throughput-map";

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

const versionedSession = { ...session } as Parameters<typeof snapshotMessages>[0];
const versionedStarted = new VersionedTimingMap(started);
const versionedEnded = new VersionedTimingMap(ended);
const throughputSession = { ...session } as Parameters<typeof snapshotMessages>[0];
const fullyVersionedSession = { ...session } as Parameters<typeof snapshotMessages>[0];
const versionedThroughput = new VersionedThroughputMap(throughput);

// One live assistant awaits its first token while 999 earlier timings are finalized.
const pendingAtMs = Date.now() - 1_000;
const pendingStored = stored.slice();
pendingStored[pendingStored.length - 1] = {
  role: "assistant", timestamp: pendingAtMs, content: [
    { type: "text", text: "working" },
    { type: "toolCall", id: "call-999", name: "bash", arguments: {} },
  ],
};
const pendingThroughput = new Map(throughput);
pendingThroughput.delete(10_000 + 999 * 10_000);
pendingThroughput.set(pendingAtMs, {
  startedAtMs: pendingAtMs, firstTokenAtMs: null, lastTokenAtMs: null,
  outputTokens: null, charCount: 0,
});
const pendingSession = { ...session, messages: pendingStored } as Parameters<typeof snapshotMessages>[0];
const pendingVersionedSession = { ...pendingSession } as Parameters<typeof snapshotMessages>[0];
const pendingVersionedThroughput = new VersionedThroughputMap(pendingThroughput);
const pendingStarted = new Map(started);
const pendingEnded = new Map(ended);
pendingStarted.set("call-999", pendingAtMs + 500);
pendingEnded.set("call-999", pendingAtMs + 1_000);
const pendingVersionedStarted = new VersionedTimingMap(pendingStarted);
const pendingVersionedEnded = new VersionedTimingMap(pendingEnded);
const combinedPendingSession = { ...pendingSession } as Parameters<typeof snapshotMessages>[0];
const combinedPendingVersionedSession = { ...pendingSession } as Parameters<typeof snapshotMessages>[0];

// Alternate the output on every call so both paths reproject and replace a row.
// Separate sessions keep each cached base projection independent.
const scanSession = { ...session } as Parameters<typeof snapshotMessages>[0];
const indexedSession = { ...session } as Parameters<typeof snapshotMessages>[0];
const scanPartial = new Map([["call-999", "partial A"]]);
const indexedPartial = new Map([["call-999", "partial A"]]);
let scanFlip = false;
let indexedFlip = false;

const cases = [
  ["history only", () => snapshotMessages(session)],
  ["throughput only", () => snapshotMessages(session, throughput)],
  ["throughput versioned", () => snapshotMessages(throughputSession, versionedThroughput)],
  ["throughput pending plain", () => snapshotMessages(pendingSession, pendingThroughput)],
  ["throughput pending versioned", () => snapshotMessages(pendingVersionedSession, pendingVersionedThroughput)],
  ["partial output only", () => snapshotMessages(session, undefined, undefined, undefined, partial)],
  ["partial output all", () => snapshotMessages(session, undefined, undefined, undefined, partialAll)],
  ["tool timing only", () => snapshotMessages(session, undefined, started, ended)],
  ["tool timing versioned", () => snapshotMessages(versionedSession, undefined, versionedStarted, versionedEnded)],
  ["throughput + partial", () => snapshotMessages(session, throughput, undefined, undefined, partial)],
  ["partial + timing", () => snapshotMessages(session, undefined, started, ended, partial)],
  ["throughput + timing", () => snapshotMessages(session, throughput, started, ended)],
  ["combined", () => snapshotMessages(session, throughput, started, ended, partial)],
  ["combined versioned", () => snapshotMessages(versionedSession, throughput, versionedStarted, versionedEnded, partial)],
  ["combined fully versioned", () => snapshotMessages(fullyVersionedSession, versionedThroughput, versionedStarted, versionedEnded, partial)],
  ["combined pending plain", () => snapshotMessages(combinedPendingSession, pendingThroughput, pendingStarted, pendingEnded, partial)],
  ["combined pending versioned", () => snapshotMessages(combinedPendingVersionedSession, pendingVersionedThroughput, pendingVersionedStarted, pendingVersionedEnded, partial)],
  ["partial changing (full scan)", () => {
    scanFlip = !scanFlip;
    scanPartial.set("call-999", scanFlip ? "partial A" : "partial B");
    return applyToolOutput(snapshotMessages(scanSession), scanPartial);
  }],
  ["partial changing (indexed)", () => {
    indexedFlip = !indexedFlip;
    indexedPartial.set("call-999", indexedFlip ? "partial A" : "partial B");
    return snapshotMessages(indexedSession, undefined, undefined, undefined, indexedPartial);
  }],
] as const;
for (const [name, run] of cases) {
  if (run().length !== stored.length) throw new Error(`Unexpected row count: ${name}`);
}

describe("cached snapshotMessages (2,000 rows)", () => {
  for (const [name, run] of cases) {
    bench(name, () => { run(); }, { time: 250, warmupTime: 100 });
  }
});
