import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { withFileLock } from "./file-lock.mjs";
import { assertConfigurationOwner } from "./configuration-command.mjs";
const LIMIT = 128;
function read(path) {
  try {
    const bytes = readFileSync(path);
    if (bytes.length > 256 * 1024) throw new Error("Invalid conversation ledger");
    const value = JSON.parse(bytes.toString("utf8"));
    if (value.version !== 1 || !Array.isArray(value.operations) || value.operations.length > LIMIT) throw new Error("Invalid conversation ledger");
    return value.operations.map(row => {
      if (!row || !/^[0-9a-f-]{36}$/.test(row.id) || !["unknown", "complete"].includes(row.execution)) throw new Error("Invalid conversation ledger");
      return { id: row.id, execution: row.execution };
    });
  } catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
function write(path, operations) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, JSON.stringify({ version: 1, operations }), { encoding: "utf8", mode: 0o600 }); renameSync(temp, path); }
  finally { rmSync(temp, { force: true }); }
}
/** Concurrent admission, NOT a global execution queue: answers and Stop must remain available during prompt preparation.
 * Only operation IDs and uncertainty are persisted; no prompt, attachment, approval or answer data.
 * Check-and-checkpoint is one file-lock transaction even across independent command instances.
 */
export function createTaskConversationCommands({ ledgerPath }) {
  return {
    async run({ operationId, handler }) {
      assertConfigurationOwner();
      if (typeof operationId !== "string" || !/^[0-9a-f-]{36}$/.test(operationId)) return Response.json({ error: "Invalid operation ID" }, { status: 400 });
      const operation = { id: operationId, execution: "unknown" };
      const path = ledgerPath();
      try {
        const previous = withFileLock(path, () => {
          const rows = read(path), previous = rows.find(row => row.id === operationId);
          if (previous) return previous;
          if (rows.length === LIMIT) {
            const complete = rows.findIndex(row => row.execution === "complete");
            if (complete < 0) throw new Error("Uncertain conversation ledger is full");
            rows.splice(complete, 1);
          }
          write(path, [...rows, operation]);
          return null;
        });
        if (previous) return Response.json({ error: "タスク操作は既に受付済みです。自動再実行しません", operation: previous }, { status: 409 });
      } catch { return Response.json({ error: "タスク操作を受付できません", operation: { ...operation, execution: "not-started" } }, { status: 503 }); }
      let response, body;
      try { response = await handler(); body = await response.json(); }
      catch { response = new Response(null, { status: 503 }); body = { error: "タスクの送信・応答結果を確認できません" }; }
      if (response.status < 500) operation.execution = "complete";
      try {
        withFileLock(path, () => {
          const rows = read(path), index = rows.findIndex(row => row.id === operationId);
          if (index < 0) throw new Error("Conversation checkpoint lost");
          rows[index] = operation; write(path, rows);
        });
      } catch { operation.execution = "unknown"; response = new Response(null, { status: 503 }); body = { error: "タスク操作の結果記録に失敗しました" }; }
      return Response.json({ ...body, operation }, { status: response.status, headers: response.headers });
    },
  };
}
