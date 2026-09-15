import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET, PATCH } from "./route";

function request(body: unknown): NextRequest {
  return new NextRequest("http://127.0.0.1:3010/api/settings/intercom", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/settings/intercom", () => {
  let agentDir = "";
  let previousAgentDir: string | undefined;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "lcp-intercom-settings-api-"));
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("defaults to replies and preserves the other intercom config keys", async () => {
    const initial = await GET();
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({ inboundTrigger: "replies" });

    const intercomDir = join(agentDir, "intercom");
    mkdirSync(intercomDir, { recursive: true });
    const configPath = join(intercomDir, "config.json");
    const existing = { brokerCommand: "bun", brokerArgs: [], replyHint: false };
    writeFileSync(configPath, JSON.stringify(existing));

    const response = await PATCH(request({ inboundTrigger: "always" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ inboundTrigger: "always" });
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
      ...existing,
      inboundTrigger: "always",
    });
  });

  it.each(["replies", "always", "never"]) ("accepts %s", async (inboundTrigger) => {
    const response = await PATCH(request({ inboundTrigger }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ inboundTrigger });
  });

  it("rejects an invalid policy", async () => {
    const response = await PATCH(request({ inboundTrigger: "active" }));
    expect(response.status).toBe(400);
  });
});
