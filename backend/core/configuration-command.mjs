import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { withFileLock } from "./file-lock.mjs";

const scope = new AsyncLocalStorage();
const MAX_OBSERVATION_BYTES = 384 * 1024 * 1024;
/** Private checksum only: paths, bytes and secret hashes never enter an HTTP DTO or the ledger. */
function fingerprint(path, budget = { bytes: 0, files: 0 }) {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isDirectory()) {
    const hash = createHash("sha256");
    for (const entry of readdirSync(path).sort()) {
      if (["node_modules", ".git", ".cache"].includes(entry)) continue;
      hash.update(entry).update(String(fingerprint(join(path, entry), budget)));
    }
    return hash.digest("hex");
  }
  if (!stat.isFile()) return "special";
  budget.bytes += stat.size; budget.files++;
  if (budget.bytes > MAX_OBSERVATION_BYTES || budget.files > 50_000) throw new Error("Configuration observation limit exceeded");
  return createHash("sha256").update(readFileSync(path)).update(String(stat.mode & 0o777)).digest("hex");
}
/** Call immediately before the owner's write, not on an untrusted submitted path. */
export function assertConfigurationOwner() {
  if (process.env.LEAFCODE_PI_PROCESS_ROLE === "next") {
    throw Object.assign(new Error("Configuration is owned by Backend"), { status: 503, code: "CONFIGURATION_NOT_OWNED" });
  }
}
export function watchConfigurationPath(path) {
  assertConfigurationOwner();
  const state = scope.getStore();
  if (state && !state.paths.has(path)) state.paths.set(path, fingerprint(path));
}
export function markConfigurationExternalWrite(stage) {
  assertConfigurationOwner();
  const state = scope.getStore();
  if (state && ["started", "saved"].includes(stage)) state.externalWrite = stage;
}
export function markConfigurationRecovery(recovery) {
  const state = scope.getStore();
  if (state && ["restored", "required"].includes(recovery)) state.recovery = recovery;
}
function changed(state) {
  for (const [path, before] of state.paths) if (fingerprint(path) !== before) return true;
  return false;
}
function readLedger(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (value.version !== 1 || !Array.isArray(value.operations)) throw new Error("Invalid configuration ledger");
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, revision: null, operations: [] };
    throw error;
  }
}
function saveLedger(path, mutation) {
  withFileLock(path, () => {
    const ledger = readLedger(path);
    if (mutation.saved) ledger.revision = mutation.revision;
    ledger.operations = [...ledger.operations.filter((row) => row.operationId !== mutation.operationId), mutation].slice(-128);
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    try { writeFileSync(temp, JSON.stringify(ledger), { encoding: "utf8", mode: 0o600 }); renameSync(temp, path); }
    finally { rmSync(temp, { force: true }); }
  });
}
/** One owner queue: writes and their live application cannot overtake one another. No automatic replay. */
export function createConfigurationCommands({ ledgerPath, apply = async () => undefined }) {
  let queue = Promise.resolve();
  return {
    read(operationId) {
      const ledger = readLedger(ledgerPath());
      return operationId ? ledger.operations.find((row) => row.operationId === operationId) ?? null : { revision: ledger.revision };
    },
    run({ operationId = randomUUID(), route, method, handler }) {
      const execute = async () => {
        const previous = readLedger(ledgerPath()).operations.find((row) => row.operationId === operationId);
        if (previous) return Response.json({ error: "設定操作は既に受付済みです。再実行せず結果を確認してください", mutation: previous }, { status: 409 });
        const state = { paths: new Map(), recovery: "none", externalWrite: "none" };
        return scope.run(state, async () => {
          let response;
          try { response = await handler(); }
          catch { response = Response.json({ error: "設定の処理に失敗しました" }, { status: 500 }); }
          let saved;
          try {
            saved = changed(state) || state.externalWrite === "saved" || (response.ok && state.paths.size > 0);
            if (!saved && state.externalWrite === "started") saved = null;
          }
          catch { saved = null; }
          const mutation = { operationId, saved, saveStatus: saved === null ? "unknown" : !saved ? "none" : response.ok ? "complete" : "partial", revision: saved ? randomUUID() : null,
            apply: saved === null ? "unknown" : response.ok ? "not-required" : saved ? "failed" : "not-required", recovery: state.recovery };
          // Persist before live reload so a disconnect/crash cannot claim an uncommitted save.
          if (saved) {
            mutation.apply = response.ok ? "unknown" : "failed";
            try { saveLedger(ledgerPath(), mutation); }
            catch { mutation.revision = null; mutation.apply = "unknown"; }
          }
          if (response.ok && saved && mutation.revision) {
            try {
              const result = await apply({ route, method, body: await response.clone().json() });
              mutation.apply = ["not-required", "deferred"].includes(result) ? result : "applied";
            } catch {
              mutation.apply = "failed";
              response = Response.json({ ...(await response.json()), error: "設定は保存しましたが実行中への反映に失敗しました" }, { status: 503, headers: response.headers });
            }
          }
          if ((saved === null || (saved && mutation.revision === null)) && response.ok) {
            response = Response.json({ ...(await response.json()), error: "設定は保存しましたが結果記録に失敗しました" }, { status: 503, headers: response.headers });
          }
          try { saveLedger(ledgerPath(), mutation); }
          catch {
            if (saved) {
              mutation.revision = null; mutation.apply = "unknown";
              if (response.ok) response = Response.json({ ...(await response.json()), error: "設定は保存しましたが結果記録に失敗しました" }, { status: 503, headers: response.headers });
            }
          }
          const body = await response.json();
          return Response.json({ ...body, mutation }, { status: response.status, headers: response.headers });
        });
      };
      const result = queue.then(execute, execute);
      queue = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}
