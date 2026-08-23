import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti/static";
import { bundledExtensionsDir } from "@/lib/extensions";
import { readCollaborationRoom, type CollaborationRoomSummary } from "@/lib/collaboration-room";

type RoomClientLike = {
  ready: boolean;
  degradedReason?: string;
  discard(leaseId: string): Promise<unknown>;
  close(): Promise<void>;
};

type RoomModule = {
  connectRoom(
    cwd: string,
    session: { sessionId: string; displayName?: string; pid?: number },
    env?: NodeJS.ProcessEnv,
  ): Promise<RoomClientLike>;
};

function collaborationRoomModulePath(): string {
  const dir = bundledExtensionsDir();
  const file = dir ? join(dir, "leafcode-collaboration", "room.ts") : "";
  if (!file || !existsSync(/* turbopackIgnore: true */ file)) {
    throw Object.assign(new Error("leafcode-collaboration の room モジュールが見つかりません。"), { status: 500 });
  }
  return file;
}

async function loadRoomModule(): Promise<RoomModule> {
  const jiti = createJiti(import.meta.url, { moduleCache: false });
  return await jiti.import(pathToFileURL(collaborationRoomModulePath()).href) as RoomModule;
}

export async function discardCollaborationLease(
  rootPath: string,
  leaseId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CollaborationRoomSummary> {
  const id = leaseId.trim();
  if (!id || id.length > 100) {
    throw Object.assign(new Error("解除する予約が指定されていません。"), { status: 400 });
  }
  const room = await loadRoomModule();
  const client = await room.connectRoom(
    rootPath,
    { sessionId: `leafcode-ui-${randomUUID()}`, displayName: "LeafCode UI", pid: process.pid },
    env,
  );
  try {
    if (!client.ready) {
      throw Object.assign(new Error(client.degradedReason || "協調coordinatorに接続できません。"), { status: 409 });
    }
    await client.discard(id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/lease_not_found|was not found/i.test(message)) {
      throw Object.assign(new Error("対象の予約が見つかりません。すでに解除された可能性があります。"), { status: 404 });
    }
    if (/not_discardable|cannot be discarded/i.test(message)) {
      throw Object.assign(new Error("この予約は解除できません。有効な予約は所有セッション側で release してください。"), { status: 409 });
    }
    throw error;
  } finally {
    await client.close();
  }
  return readCollaborationRoom(rootPath, env);
}
