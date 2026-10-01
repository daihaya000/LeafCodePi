import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  forwardBotAdmin,
  forwardLiveSessionsReload,
  forwardProjectTeardown,
  forwardTaskAdmin,
  forwardTaskTeardown,
} from "@/lib/backend-forward";
import { createTaskOnBackend } from "@/lib/backend-client";

/**
 * The WebUI's forwarding helpers against the real Backend HTTP server, with stub owner handlers.
 *
 * Each side has its own unit tests, but a path, suffix or envelope that the two sides disagree on
 * passes both. This is the one place where the real client functions talk to the real router, so a
 * route registered under a different name (or an answer wrapped differently) fails here first.
 */
type BackendServerModule = {
  createBackendServer: (options: Record<string, unknown>) => unknown;
  listenBackend: (server: unknown, port: number) => Promise<{ port: number }>;
  closeBackend: (server: unknown) => Promise<void>;
};

const servers: unknown[] = [];
let backend: BackendServerModule;

async function start(handlers: Record<string, unknown>) {
  backend ??= (await import("../../../backend/src/server.mjs")) as unknown as BackendServerModule;
  const token = randomBytes(32).toString("base64url");
  const server = backend.createBackendServer({ token, ...handlers });
  servers.push(server);
  const address = await backend.listenBackend(server, 0);
  const env = { LEAFCODE_PI_BACKEND_URL: `http://127.0.0.1:${address.port}`, LEAFCODE_PI_BACKEND_TOKEN: token };
  return { env };
}

afterEach(async () => {
  while (servers.length) await backend.closeBackend(servers.pop());
});

describe("forwarding helpers against the real Backend router", () => {
  it("task teardown: archive and destroy reach the owner, a miss is not-found", async () => {
    const seen: unknown[] = [];
    const { env } = await start({
      teardownTaskAction: async (id: string, mode: string) => {
        seen.push([id, mode]);
        if (id === "gone") throw Object.assign(new Error("missing"), { status: 404 });
        return mode === "destroy" ? { ok: true } : { id, status: "archived" };
      },
    });
    await expect(forwardTaskTeardown("task 1", "archive", { env })).resolves.toEqual({
      ok: true, result: { id: "task 1", status: "archived" },
    });
    await expect(forwardTaskTeardown("task-1", "destroy", { env })).resolves.toEqual({ ok: true, result: { ok: true } });
    await expect(forwardTaskTeardown("gone", "destroy", { env })).resolves.toEqual({
      ok: false, reason: "not-found", status: 404,
    });
    expect(seen).toEqual([["task 1", "archive"], ["task-1", "destroy"], ["gone", "destroy"]]);
  });

  it("task admin: promote, hand-off and release keep the owner's status and body", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { env } = await start({
      taskAdminAction: async (id: string, request: Record<string, unknown>) => {
        seen.push({ id, ...request });
        return request.action === "promote"
          ? { status: 409, body: { error: "移動先が使われています" } }
          : { status: 200, body: { task: { id } } };
      },
    });
    await expect(forwardTaskAdmin("t1", { action: "promote", destinationPath: "C:\\work" }, { env })).resolves.toEqual({
      ok: true, status: 409, body: { error: "移動先が使われています" },
    });
    await expect(forwardTaskAdmin("t1", { action: "handoff", botId: "bot-1" }, { env })).resolves.toEqual({
      ok: true, status: 200, body: { task: { id: "t1" } },
    });
    await expect(forwardTaskAdmin("t1", { action: "release" }, { env })).resolves.toMatchObject({ ok: true, status: 200 });
    expect(seen.map((entry) => entry.action)).toEqual(["promote", "handoff", "release"]);
    expect(seen[0].destinationPath).toBe("C:\\work");
    expect(seen[1].botId).toBe("bot-1");
  });

  it("project teardown: archive, move and delete reach the owner", async () => {
    const seen: unknown[] = [];
    const { env } = await start({
      teardownProjectAction: async (id: string, action: string, destinationPath?: string) => {
        seen.push([id, action, destinationPath]);
        return { status: action === "migrate" ? 409 : 200, body: { action } };
      },
    });
    await expect(forwardProjectTeardown("p 1", { action: "archive" }, { env })).resolves.toEqual({
      ok: true, status: 200, body: { action: "archive" },
    });
    await expect(forwardProjectTeardown("p-1", { action: "migrate", destinationPath: "D:\\moved" }, { env })).resolves.toEqual({
      ok: true, status: 409, body: { action: "migrate" },
    });
    await forwardProjectTeardown("p-1", { action: "destroy" }, { env });
    expect(seen).toEqual([["p 1", "archive", undefined], ["p-1", "migrate", "D:\\moved"], ["p-1", "destroy", undefined]]);
  });

  it("bot admin: a settings change and a deletion reach the owner with the body intact", async () => {
    const seen: unknown[] = [];
    const { env } = await start({
      botAdminAction: async (id: string, action: string, body: unknown) => {
        seen.push([id, action, body]);
        return action === "delete" ? { status: 200, body: { ok: true } } : { status: 200, body: { bot: { id } } };
      },
    });
    await expect(forwardBotAdmin("b1", { action: "patch", body: { enabled: false, name: "名前" } }, { env })).resolves.toEqual({
      ok: true, status: 200, body: { bot: { id: "b1" } },
    });
    await expect(forwardBotAdmin("b1", { action: "delete" }, { env })).resolves.toEqual({
      ok: true, status: 200, body: { ok: true },
    });
    expect(seen).toEqual([["b1", "patch", { enabled: false, name: "名前" }], ["b1", "delete", null]]);
  });

  it("live session reload: reload and refresh-agent reach the owner", async () => {
    const seen: unknown[] = [];
    const { env } = await start({
      reloadLiveSessionsAction: async (request: unknown) => {
        seen.push(request);
        return { ok: true };
      },
    });
    await expect(forwardLiveSessionsReload({ action: "reload" }, { env })).resolves.toEqual({ ok: true, result: { ok: true } });
    await forwardLiveSessionsReload({ action: "refresh-agent", agentName: "reviewer" }, { env });
    expect(seen).toEqual([{ action: "reload" }, { action: "refresh-agent", agentName: "reviewer" }]);
  });

  it("task creation: the route's input shape passes the owner's field allow-list", async () => {
    const seen: unknown[] = [];
    const { env } = await start({
      createTask: async (input: unknown) => {
        seen.push(input);
        return { id: "created" };
      },
    });
    // The fields app/api/tasks/route.ts builds: any extra key would be refused as a privileged field.
    const input = {
      projectId: null, prompt: "開始", model: "provider::model", thinkingLevel: "high", images: [], files: [],
      agent: "reviewer", accountId: "acct", accountIdExplicit: true, goalLoop: { acceptance: ["done"], autoAgent: false },
    };
    const created = await createTaskOnBackend(input, { env });
    expect(created).toMatchObject({ ok: true, body: { task: { id: "created" } } });
    expect(seen).toEqual([input]);
    const refused = await createTaskOnBackend({ ...input, permissionMode: "allow" }, { env });
    expect(refused).toMatchObject({ ok: false, status: 400 });
    expect(seen).toHaveLength(1);
  });

  it("a detached owner answers 503 instead of acting", async () => {
    const { env } = await start({});
    await expect(forwardTaskTeardown("t1", "archive", { env })).resolves.toMatchObject({ ok: false, status: 503 });
    await expect(forwardBotAdmin("b1", { action: "delete" }, { env })).resolves.toMatchObject({ ok: false, status: 503 });
    await expect(forwardLiveSessionsReload({ action: "reload" }, { env })).resolves.toMatchObject({ ok: false, status: 503 });
  });
});
