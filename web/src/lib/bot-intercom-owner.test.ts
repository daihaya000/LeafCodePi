import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dispatchJsonBusinessRequest } from "@backend-runtime/json-business/index";
import * as bots from "@backend-runtime/lib/bots";
import * as intercom from "@backend-runtime/lib/bot-intercom";

let root: string;
const residents = new Set<string>();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "leafcode-bot-intercom-owner-"));
  residents.clear();
  intercom.resetBotIntercomForTests();
  intercom.setBotIntercomResidentLookup((id) => residents.has(id));
  for (const [key, value] of Object.entries({
    LEAFCODE_PI_PROCESS_ROLE: "backend",
    LEAFCODE_PI_DATA_DIR: root,
    PI_CODING_AGENT_DIR: join(root, "agent"),
  })) vi.stubEnv(key, value);
});

afterEach(() => {
  intercom.resetBotIntercomForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function enableIntercom(id: string) {
  return bots.patchBot(id, {
    tools: [...new Set([...bots.BOT_DEFAULT_TOOL_NAMES, "intercom" as const])],
    intercomEnabled: true,
  });
}

function request(
  botId: string,
  method: "GET" | "PATCH",
  body?: unknown,
  options: { authorized?: boolean; origin?: string; operationId?: string } = {},
) {
  const route = `bots/${botId}/intercom`;
  return dispatchJsonBusinessRequest({
    route,
    method,
    url: `http://localhost/api/${route}`,
    headers: {
      host: "localhost",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.origin ? { origin: options.origin } : {}),
    },
    authorized: options.authorized ?? true,
    ...(options.operationId ? { operationId: options.operationId } : {}),
    ...(body === undefined ? {} : { body: new TextEncoder().encode(JSON.stringify(body)) }),
  });
}

it("Backend owner serves the inbox, marks it read once, and rejects duplicate execution", async () => {
  const sender = bots.createBot({ name: "Sender" });
  const recipient = bots.createBot({ name: "Recipient" });
  enableIntercom(sender.id);
  enableIntercom(recipient.id);
  residents.add(recipient.id);
  intercom.sendBotIntercom({ fromBotId: sender.id, to: recipient.id, text: "owner inbox" });

  const get = await request(recipient.id, "GET");
  expect(get.status).toBe(200);
  expect(get.body?.inbox).toMatchObject({ unreadCount: 1, messages: [expect.objectContaining({ text: "owner inbox" })] });

  const markRead = vi.spyOn(intercom, "markBotIntercomInboxRead");
  const operationId = randomUUID();
  const first = await request(recipient.id, "PATCH", { action: "read", botId: "forged", readAt: 0 }, { operationId });
  const replay = await request(recipient.id, "PATCH", { action: "read", botId: "forged", readAt: 0 }, { operationId });
  expect(first.status).toBe(200);
  expect(first.body).toMatchObject({ inbox: { unreadCount: 0 }, operation: { id: operationId, execution: "complete" } });
  expect(replay.status).toBe(409);
  expect(replay.body?.operation).toMatchObject({ id: operationId, execution: "complete" });
  expect(markRead).toHaveBeenCalledExactlyOnceWith(recipient.id);
});

it("Backend authorization, Origin, body bounds, and malformed actions precede inbox mutation", async () => {
  const bot = bots.createBot({ name: "Recipient" });
  const markRead = vi.spyOn(intercom, "markBotIntercomInboxRead");
  expect((await request(bot.id, "GET", undefined, { authorized: false })).status).toBe(401);
  expect((await request(bot.id, "PATCH", { action: "read" }, { origin: "https://evil.invalid", operationId: randomUUID() })).status).toBe(403);
  expect((await request(bot.id, "PATCH", "x".repeat(4097), { operationId: randomUUID() })).status).toBe(413);
  expect((await request(bot.id, "PATCH", { action: "unknown" }, { operationId: randomUUID() })).status).toBe(400);
  expect(markRead).not.toHaveBeenCalled();
});
