import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { withFileLock } from "./file-lock.mjs";
import { assertConfigurationOwner } from "./configuration-command.mjs";
function read(path) {
  try {
    const bytes = readFileSync(path); if (bytes.length > 256 * 1024) throw new Error("Invalid auth ledger");
    const value = JSON.parse(bytes.toString("utf8"));
    if (value.version !== 1 || !Array.isArray(value.operations) || value.operations.length > 128) throw new Error("Invalid auth ledger");
    for (const row of value.operations) if (!row || !/^[0-9a-f-]{36}$/.test(row.id) || !["unknown", "complete"].includes(row.execution)) throw new Error("Invalid auth ledger");
    return value.operations;
  } catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
function save(path, operation) {
  withFileLock(path, () => {
    const operations = [...read(path).filter(row => row.id !== operation.id), operation].slice(-128);
    mkdirSync(dirname(path), { recursive: true }); const temp = `${path}.${randomUUID()}.tmp`;
    try { writeFileSync(temp, JSON.stringify({ version: 1, operations }), { encoding: "utf8", mode: 0o600 }); renameSync(temp, path); }
    finally { rmSync(temp, { force: true }); }
  });
}
/** Admission/result receipt only, never a credential-save claim. Async login success comes from owner SSE. */
export function createProviderAuthCommands({ ledgerPath }) {
  let queue = Promise.resolve();
  return {
    run({ operationId, handler }) {
      const execute = async () => {
        assertConfigurationOwner();
        if (typeof operationId !== "string" || !/^[0-9a-f-]{36}$/.test(operationId)) return Response.json({ error: "Invalid operation ID" }, { status: 400 });
        const operation = { id: operationId, execution: "unknown" };
        try {
          const previous = read(ledgerPath()).find(row => row.id === operationId);
          if (previous) return Response.json({ error: "認証操作は既に受付済みです。自動再実行しません", operation: previous }, { status: 409 });
          save(ledgerPath(), operation);
        } catch { return Response.json({ error: "認証操作を受付できません", operation: { ...operation, execution: "not-started" } }, { status: 503 }); }
        let response;
        try { response = await handler(); }
        catch { response = Response.json({ error: "認証操作の結果を確認できません" }, { status: 503 }); }
        if (response.status < 500) operation.execution = "complete";
        try { save(ledgerPath(), operation); }
        catch { operation.execution = "unknown"; response = Response.json({ error: "認証操作の結果記録に失敗しました" }, { status: 503 }); }
        return Response.json({ ...(await response.json()), operation }, { status: response.status, headers: response.headers });
      };
      const result = queue.then(execute, execute); queue = result.then(() => undefined, () => undefined); return result;
    },
  };
}
