import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SubagentRunDto } from "@/lib/types";
import { GET } from "./route";

const originalDataDir = process.env.LEAFCODE_PI_DATA_DIR;
let root: string;
let sessionFile: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "leafcode-pi-subagents-route-"));
  process.env.LEAFCODE_PI_DATA_DIR = path.join(root, "data");

  const sessionDir = path.join(root, "sessions", "key");
  const artifactsDir = path.join(sessionDir, "subagent-artifacts");
  fs.mkdirSync(artifactsDir, { recursive: true });
  sessionFile = path.join(sessionDir, "2026_abc.jsonl");
  fs.writeFileSync(sessionFile, "");
  fs.writeFileSync(
    path.join(artifactsDir, "run-1_programmer_transcript.jsonl"),
    `${JSON.stringify({
      recordType: "message",
      runId: "run-1",
      agent: "programmer",
      ts: Date.now(),
      message: { role: "user", content: [{ type: "text", text: "やって" }] },
    })}\n`,
    "utf-8",
  );

  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "data", "store.json"),
    JSON.stringify({
      version: 1,
      projects: [],
      tasks: [
        {
          id: "task-1",
          projectId: "p1",
          projectName: "repo",
          title: "t",
          directory: root,
          isolation: "current_folder",
          status: "working",
          sessionId: "s1",
          sessionFile,
          createdAt: "2026-08-22T00:00:00.000Z",
          updatedAt: "2026-08-22T00:00:00.000Z",
          error: null,
        },
      ],
    }),
    "utf-8",
  );
});

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
  else process.env.LEAFCODE_PI_DATA_DIR = originalDataDir;
  fs.rmSync(root, { recursive: true, force: true });
});

function get(taskId: string, query = ""): Promise<Response> {
  return GET(new NextRequest(`http://localhost/api/tasks/${taskId}/subagents${query}`), {
    params: Promise.resolve({ id: taskId }),
  });
}

describe("GET /api/tasks/[id]/subagents", () => {
  it("returns the child runs of the task session", async () => {
    const response = await get("task-1");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { runs: SubagentRunDto[] };
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]).toMatchObject({ runId: "run-1", agent: "programmer", status: "running" });
    expect(body.runs[0]!.messages[0]).toMatchObject({ role: "user" });
  });

  it("filters by the since parameter", async () => {
    const response = await get("task-1", `?since=${Date.now() + 60_000}`);
    const body = (await response.json()) as { runs: SubagentRunDto[] };
    expect(body.runs).toEqual([]);
  });

  it("404s for an unknown task", async () => {
    const response = await get("nope");
    expect(response.status).toBe(404);
  });
});
