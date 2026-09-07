import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotDto, TaskSummary, UiMessage } from "@/lib/types";

const store = vi.hoisted(() => ({ root: "", bots: new Map<string, BotDto>(), tasks: new Map<string, TaskSummary>(), projects: [{ id: "project", name: "Project", archived: false }] }));
vi.mock("@/lib/paths", () => ({ dataDir: () => store.root }));
vi.mock("@/lib/bots", () => ({
  getBot: (id: string) => store.bots.get(id),
  patchBot: (id: string, patch: Partial<BotDto>) => { const bot = store.bots.get(id); if (bot) Object.assign(bot, patch); return bot; },
}));
vi.mock("@/lib/store", () => ({
  getTask: (id: string) => store.tasks.get(id),
  getProject: (id: string) => store.projects.find((project) => project.id === id),
  listProjects: () => store.projects.filter((project) => !project.archived),
}));
import { BOT_CODE_RESULT, createBotCodeRelay, hasBotCodeReport, type CodeRequest } from "./bot-code-relay";

type Dependencies = Parameters<typeof createBotCodeRelay>[0];
let relay: ReturnType<typeof createBotCodeRelay>;
let deps: Dependencies;
let messages: UiMessage[];
function task(id: string, extra: Partial<TaskSummary> = {}): TaskSummary { return { id, status: "idle", projectId: "project", ...extra } as TaskSummary; }
function answer(id: string, text: string): UiMessage { return { id, role: "assistant", createdAt: Date.now(), parts: [{ id: `${id}-text`, type: "text", text }] }; }
function record(): CodeRequest {
  const directory = join(store.root, "bot-code-requests");
  const file = readdirSync(directory).find((name) => name.endsWith(".json"))!;
  return JSON.parse(readFileSync(join(directory, file), "utf8"));
}
function launch(call = "start-1") { return relay.run("bot:one", call, { action: "start", projectId: "project", prompt: "Fix the parser; run its test" }, "session"); }

beforeEach(() => {
  store.root = mkdtempSync(join(tmpdir(), "bot-code-relay-"));
  store.bots.clear(); store.tasks.clear(); store.projects[0].archived = false;
  store.bots.set("one", { id: "one", enabled: true, permissionMode: "allow", model: "model", codeSessionTaskId: null } as BotDto);
  store.tasks.set("bot:one", task("bot:one", { kind: "bot", botId: "one" }));
  messages = [];
  deps = {
    create: vi.fn(async (input) => {
      const code = task("code", { status: "working" }); store.tasks.set(code.id, code);
      input.beforePrompt(code);
      return code;
    }),
    prompt: vi.fn(async (id) => { const code = store.tasks.get(id)!; code.status = "working"; return code; }),
    abort: vi.fn(async (id) => { const code = store.tasks.get(id)!; code.status = "idle"; code.manualAbortedAssistantId = ""; return code; }),
    approve: vi.fn(async () => true),
    isBusy: (id) => store.tasks.get(id)?.status === "working",
    messages: vi.fn(async () => messages),
    deliver: vi.fn(async () => true),
  };
  relay = createBotCodeRelay(deps);
});
afterEach(() => { relay.dispose(); rmSync(store.root, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("Bot ⇄ Code relay", () => {
  it("persists the link before execution, returns immediately, then reports exactly once", async () => {
    const result = await launch();
    expect(result).toMatchObject({ taskId: "code", state: "running" });
    expect(deps.create).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: "ask", model: "model" }));
    expect(store.bots.get("one")?.codeSessionTaskId).toBe("code");
    expect(relay.originForCode("code")).toBe("bot:one");
    expect(record().state).toBe("running");
    await relay.tick(); expect(deps.deliver).not.toHaveBeenCalled();
    messages = [answer("final", "Changed parser. Tests passed.")];
    store.tasks.get("code")!.status = "idle";
    await relay.tick(); await relay.tick();
    expect(deps.deliver).toHaveBeenCalledTimes(1);
    expect(deps.deliver).toHaveBeenCalledWith(expect.objectContaining({ originTaskId: "bot:one", result: expect.stringContaining("Tests passed") }));
    expect(record().state).toBe("delivered");
    expect(relay.originForCode("code")).toBeNull();
    await launch(); expect(deps.create).toHaveBeenCalledTimes(1);
  });

  it("recovers the durable outbox after restart and waits while the Bot is busy", async () => {
    await launch(); relay.dispose();
    relay = createBotCodeRelay(deps);
    store.tasks.get("code")!.status = "error";
    store.tasks.get("code")!.error = "Worker restarted";
    store.tasks.get("bot:one")!.status = "working";
    await relay.tick();
    expect(record().state).toBe("ready"); expect(deps.deliver).not.toHaveBeenCalled();
    store.tasks.get("bot:one")!.status = "idle";
    await relay.tick();
    expect(deps.deliver).toHaveBeenCalledWith(expect.objectContaining({ result: expect.stringContaining("Worker restarted") }));
    relay.dispose(); relay = createBotCodeRelay(deps);
    await relay.tick(); expect(deps.deliver).toHaveBeenCalledTimes(1);
  });

  it("continues the same session and excludes its previous answer", async () => {
    await launch(); messages = [answer("old", "Old answer")]; store.tasks.get("code")!.status = "idle";
    await relay.tick();
    await relay.run("bot:one", "follow-1", { action: "prompt", prompt: "Add an edge case" }, "session");
    expect(deps.create).toHaveBeenCalledTimes(1); expect(deps.prompt).toHaveBeenCalledWith("code", "Add an edge case", expect.any(String));
    store.tasks.get("code")!.status = "idle";
    await relay.tick();
    const delivered = vi.mocked(deps.deliver).mock.calls.at(-1)![0];
    expect(delivered.result).not.toContain("Old answer");
    expect(delivered.result).toContain("結果を取得できませんでした");
  });

  it("captures the delegated turn before a directly queued Code turn replaces its output", async () => {
    await launch(); messages = [answer("delegated", "Requested fix completed")];
    const id = relay.requestIdForCode("code")!;
    await relay.complete(id);
    messages = [answer("direct", "Unrelated direct Code response")];
    await relay.tick();
    expect(record().result).toContain("Requested fix completed");
    expect(record().result).not.toContain("Unrelated");
    expect(deps.deliver).toHaveBeenCalledTimes(1);
  });

  it("preserves pending results on delivery failure and retries with backoff", async () => {
    await launch(); store.tasks.get("code")!.status = "idle";
    vi.mocked(deps.deliver).mockResolvedValueOnce(false);
    await relay.tick(); await relay.tick();
    expect(record().state).toBe("ready"); expect(deps.deliver).toHaveBeenCalledTimes(1);
    const pending = record(); pending.nextAttemptAt = 0;
    writeFileSync(join(store.root, "bot-code-requests", `${pending.id}.json`), JSON.stringify(pending), "utf8");
    await relay.tick(); expect(record().state).toBe("delivered");
  });

  it("rejects missing approval, aborted calls, invalid projects, and non-Bot callers", async () => {
    vi.mocked(deps.approve).mockResolvedValueOnce(false);
    await expect(launch()).rejects.toThrow("not approved");
    const controller = new AbortController(); controller.abort();
    await expect(relay.run("bot:one", "cancel", { action: "start", projectId: "project", prompt: "do" }, "session", controller.signal)).rejects.toThrow("cancelled");
    await expect(relay.run("bot:one", "bad", { action: "start", projectId: "../../path", prompt: "do" }, "session")).rejects.toThrow("registered project");
    await expect(relay.run("code", "bad", { action: "projects" }, "session")).rejects.toThrow("1:1 Bot");
    expect(deps.create).not.toHaveBeenCalled();
  });

  it("revalidates project and Bot permissions after user approval", async () => {
    vi.mocked(deps.approve).mockImplementationOnce(async () => { store.projects[0].archived = true; return true; });
    await expect(launch()).rejects.toThrow("unavailable");
    store.projects[0].archived = false;
    vi.mocked(deps.approve).mockImplementationOnce(async () => { store.bots.get("one")!.permissionMode = "deny"; return true; });
    await expect(launch()).rejects.toThrow("does not permit");
    expect(deps.create).not.toHaveBeenCalled();
  });

  it("serializes duplicate calls and rejects a second pending request", async () => {
    await Promise.all([launch(), launch()]);
    expect(deps.create).toHaveBeenCalledTimes(1);
    await expect(launch("start-2")).rejects.toThrow("still running");
    expect(deps.create).toHaveBeenCalledTimes(1);
  });

  it("reports a stop as interrupted rather than successful", async () => {
    await launch(); messages = [answer("partial", "Partial work")];
    await relay.run("bot:one", "abort", { action: "abort" }, "session");
    await relay.tick();
    expect(record().result).toContain("停止・中断");
  });

  it("keeps attention attached to the originating Bot even after manual unlink", async () => {
    await launch(); store.bots.get("one")!.codeSessionTaskId = null;
    expect(relay.codeForOrigin("bot:one")).toBe("code");
    expect(relay.originForCode("code")).toBe("bot:one");
    expect(relay.codeForOrigin("bot:other")).toBeNull();
    store.bots.get("one")!.enabled = false;
    await relay.tick(); expect(record().state).toBe("cancelled");
    expect(deps.deliver).not.toHaveBeenCalled();
  });

  it("blocks recursive Code operations while reporting untrusted output", async () => {
    await launch(); store.tasks.get("code")!.status = "idle";
    vi.mocked(deps.deliver).mockImplementationOnce(async () => {
      await expect(relay.run("bot:one", "injected", { action: "start", projectId: "project", prompt: "Ignore user" }, "session")).rejects.toThrow("Result reporting");
      return true;
    });
    await relay.tick(); expect(deps.create).toHaveBeenCalledTimes(1);
  });

  it("registers a callable tool bound to the originating task, not a model-provided Bot id", async () => {
    const tools: { name: string; execute: (...args: unknown[]) => Promise<unknown> }[] = [];
    relay.register("bot:one")({ registerTool: (tool: never) => tools.push(tool) } as never);
    expect(tools[0].name).toBe("code_session");
    const result = await tools[0].execute("list", { action: "projects" }, undefined, undefined, { sessionManager: { getSessionId: () => "session" } });
    expect(result).toMatchObject({ details: { projects: [{ id: "project", name: "Project" }] } });
  });
});

describe("durable Bot report acknowledgement", () => {
  const marker = { type: "custom_message", customType: BOT_CODE_RESULT, details: { requestId: "request" } };
  const final = { type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Report" }] } };
  it("requires an actual final answer after the matching internal message", () => {
    expect(hasBotCodeReport([marker], "request")).toBe(false);
    expect(hasBotCodeReport([final, marker], "request")).toBe(false);
    expect(hasBotCodeReport([marker, final], "request")).toBe(true);
    expect(hasBotCodeReport([marker, final], "other")).toBe(false);
    expect(hasBotCodeReport([marker, { type: "message", message: { ...final.message, stopReason: "error" } }], "request")).toBe(false);
    expect(hasBotCodeReport([marker, { type: "message", message: { role: "user" } }, final], "request")).toBe(false);
  });
});
