import { existsSync, readFileSync, statSync } from "node:fs";
import {
  buildSessionContext,
  migrateSessionEntries,
  parseSessionEntries,
} from "@earendil-works/pi-coding-agent";
import {
  conversationFromPiMessages,
  type ConversationMessage,
} from "@/lib/direct-generation-text";

const MAX_SESSION_FILE_BYTES = 4_000_000;

/** Read a persisted Pi session without opening a writable SessionManager. */
export function readSessionConversation(sessionFile: string | null | undefined): ConversationMessage[] {
  if (!sessionFile || !existsSync(sessionFile)) return [];
  try {
    const stats = statSync(sessionFile);
    if (!stats.isFile() || stats.size > MAX_SESSION_FILE_BYTES) return [];
    const entries = parseSessionEntries(readFileSync(sessionFile, "utf8"));
    migrateSessionEntries(entries);
    const sessionEntries = entries.filter((entry) => entry.type !== "session");
    return conversationFromPiMessages(buildSessionContext(sessionEntries).messages);
  } catch {
    return [];
  }
}
