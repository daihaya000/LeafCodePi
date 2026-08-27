import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { getTask, insertTask, upsertProject } from "@/lib/store";
import { setTaskAgent } from "./harness";

const GLOBAL_KEY = "__leafcodePiHarness";
const previousHarness = (globalThis as Record<string, unknown>)[GLOBAL_KEY];
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
const tempDirs: string[] = [];

afterEach(() => {
  if (previousHarness === undefined) delete (globalThis as Record<string, unknown>)[GLOBAL_KEY];
  else (globalThis as Record<string, unknown>)[GLOBAL_KEY] = previousHarness;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
  else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "leafcode-pi-harness-agent-"));
  tempDirs.push(root);
  const agentDir = join(root, "agent");
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  writeFileSync(
    join(agentDir, "agents", "reviewer.md"),
    "---\nname: reviewer\n---\n\nReview the work.\n",
    "utf8",
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.LEAFCODE_PI_DATA_DIR = join(root, "data");

  const project = upsertProject({ name: "demo", rootPath: root });
  const task = insertTask({ project, title: "switch agent", agent: "build" });
  let unsubscribed = false;
  let disposed = false;
  const live = new Map([[task.id, {
    accountId: null,
    session: {
      isStreaming: false,
      dispose: () => {
        disposed = true;
      },
    },
    unsubscribe: () => {
      unsubscribed = true;
    },
  }]]);
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
    live,
    events: new EventEmitter(),
  };
  return { task, live, get disposed() { return disposed; }, get unsubscribed() { return unsubscribed; } };
}

describe("setTaskAgent", () => {
  it("persists the selected persona and disposes the idle session for restart", async () => {
    const state = fixture();

    const updated = await setTaskAgent(state.task.id, "reviewer");

    assert.equal(updated.agent, "reviewer");
    assert.equal(getTask(state.task.id)?.agent, "reviewer");
    assert.equal(state.live.has(state.task.id), false);
    assert.equal(state.disposed, true);
    assert.equal(state.unsubscribed, true);
  });
});
