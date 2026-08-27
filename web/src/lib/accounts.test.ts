import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import {
  accountAuthPath,
  accountHasProvider,
  accountDir,
  accountModelsStorePath,
  accountStoredProviders,
  createAccount,
  deleteAccount,
  getAccount,
  listAccounts,
  patchAccount,
} from "@/lib/accounts";
import { insertTask, patchTask, upsertProject } from "@/lib/store";
import type { TaskSummary } from "@/lib/types";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.LEAFCODE_PI_DATA_DIR;
});

function tempDataDir() {
  const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-accounts-"));
  dirs.push(dir);
  process.env.LEAFCODE_PI_DATA_DIR = dir;
  return dir;
}

function httpStatus(error: unknown): unknown {
  return (error as { status?: unknown }).status;
}

/** accountId を Phase 5 まで TaskSummary 型に載せないため、実行時だけ緩く付与する。 */
function patchLoose(
  taskId: string,
  patch: Record<string, unknown>,
): TaskSummary | undefined {
  const fn = patchTask as unknown as (
    id: string,
    patch: Record<string, unknown>,
  ) => TaskSummary | undefined;
  return fn(taskId, patch);
}

describe("accounts path helpers", () => {
  it("resolves paths under <agentDir>/accounts/<id>", () => {
    const agentDir = join("C:", "Users", "demo", ".pi", "agent");
    assert.equal(accountDir("a1", agentDir), join(agentDir, "accounts", "a1"));
    assert.equal(
      accountAuthPath("a1", agentDir),
      join(agentDir, "accounts", "a1", "auth.json"),
    );
    assert.equal(
      accountModelsStorePath("a1", agentDir),
      join(agentDir, "accounts", "a1", "models-store.json"),
    );
  });
});

describe("accountStoredProviders", () => {
  it("reads known provider keys from the account auth file", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "leafcode-pi-agentdir-"));
    dirs.push(agentDir);
    const dir = accountDir("acc-9", agentDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      accountAuthPath("acc-9", agentDir),
      JSON.stringify({
        "openai-codex": { type: "oauth" },
        anthropic: { type: "oauth" },
        cursor: { type: "oauth" },
        commandcode: { type: "oauth" },
        opencode: { type: "api_key" },
        "opencode-go": { type: "api_key" },
      }),
      "utf8",
    );
    // 既知のプロバイダーだけを既定順で返す
    assert.deepEqual(accountStoredProviders("acc-9", agentDir), [
      "openai-codex",
      "anthropic",
      "commandcode",
      "cursor",
      "opencode",
      "opencode-go",
    ]);
  });

  it("returns empty when auth file is missing or broken", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "leafcode-pi-agentdir-"));
    dirs.push(agentDir);
    assert.deepEqual(accountStoredProviders("none", agentDir), []);
    const broken = accountDir("broken", agentDir);
    mkdirSync(broken, { recursive: true });
    writeFileSync(accountAuthPath("broken", agentDir), "{oops", "utf8");
    assert.deepEqual(accountStoredProviders("broken", agentDir), []);
  });
});

describe("accounts store CRUD", () => {
  it("allows only the account's registered provider", () => {
    tempDataDir();
    const account = createAccount({
      label: "Codex",
      providers: ["openai-codex"],
    });

    assert.equal(accountHasProvider(account, "openai-codex"), true);
    assert.equal(accountHasProvider(account, "anthropic"), false);
    assert.equal(accountHasProvider(account, "llama-server"), false);
  });

  it("creates, lists and gets accounts with persistence", () => {
    const dir = tempDataDir();
    const created = createAccount({
      label: "  仕事用 ChatGPT  ",
      providers: ["anthropic", "openai-codex"],
      note: "メイン",
    });
    assert.equal(created.label, "仕事用 ChatGPT");
    // 既定順（openai-codex → anthropic）で正規化される
    assert.deepEqual(created.providers, ["openai-codex", "anthropic"]);
    assert.equal(created.note, "メイン");

    assert.deepEqual(
      listAccounts().map((account) => account.id),
      [created.id],
    );
    assert.deepEqual(getAccount(created.id), created);

    // accounts.json へ永続化されている
    assert.ok(existsSync(join(dir, "accounts.json")));
    const raw = JSON.parse(
      readFileSync(join(dir, "accounts.json"), "utf8"),
    ) as {
      version: number;
      accounts: AccountRecordLike[];
    };
    assert.equal(raw.version, 1);
    assert.equal(raw.accounts.length, 1);
  });

  it("rejects invalid input with status 400", () => {
    tempDataDir();
    assert.throws(
      () => createAccount({ label: "", providers: ["openai-codex"] }),
      (error) => httpStatus(error) === 400,
    );
    assert.throws(
      () => createAccount({ label: "x", providers: [] }),
      (error) => httpStatus(error) === 400,
    );
    assert.throws(
      () => createAccount({ label: "x", providers: ["not-a-provider"] }),
      (error) => httpStatus(error) === 400,
    );
    assert.throws(
      () => createAccount({ label: "x", providers: "openai-codex" }),
      (error) => httpStatus(error) === 400,
    );
  });

  it("patches label and note without touching providers", () => {
    tempDataDir();
    const created = createAccount({
      label: "before",
      providers: ["anthropic"],
      note: "old",
    });

    const patched = patchAccount(created.id, { label: "after", note: "new" });
    assert.equal(patched.label, "after");
    assert.equal(patched.note, "new");
    assert.deepEqual(patched.providers, ["anthropic"]);

    // 空文字の note は削除扱い
    const cleared = patchAccount(created.id, { note: "" });
    assert.equal(cleared.note, undefined);

    const reloaded = getAccount(created.id);
    assert.equal(reloaded?.label, "after");
    assert.deepEqual(reloaded?.providers, ["anthropic"]);
    assert.ok(reloaded && reloaded.updatedAt >= created.createdAt);

    assert.throws(
      () => patchAccount("missing", { label: "x" }),
      (error) => httpStatus(error) === 404,
    );
  });

  it("deletes an account and returns 404 afterwards", () => {
    tempDataDir();
    const created = createAccount({
      label: "tmp",
      providers: ["openai-codex"],
    });
    deleteAccount(created.id);
    assert.equal(getAccount(created.id), undefined);
    assert.deepEqual(listAccounts(), []);
    assert.throws(
      () => deleteAccount(created.id),
      (error) => httpStatus(error) === 404,
    );
  });

  it("refuses to delete while a working task references the account", () => {
    tempDataDir();
    const project = upsertProject({
      name: "demo",
      rootPath: join(tmpdir(), "demo-root"),
    });
    const task = insertTask({ project, title: "running task" });
    const account = createAccount({
      label: "busy",
      providers: ["openai-codex"],
    });

    // 実行中タスクからの参照が無ければ削除できる
    deleteAccount(account.id);
    assert.equal(getAccount(account.id), undefined);

    const busy = createAccount({ label: "busy2", providers: ["openai-codex"] });
    const patched = patchLoose(task.id, {
      status: "working",
      accountId: busy.id,
    });
    assert.ok(patched);
    assert.throws(
      () => deleteAccount(busy.id),
      (error) => httpStatus(error) === 409,
    );
  });
});

type AccountRecordLike = {
  id: string;
  label: string;
};
