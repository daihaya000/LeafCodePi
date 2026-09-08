import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { NextRequest } from "next/server";
import { GET, PATCH as PATCH_ACCOUNTS, POST } from "./route";
import { DELETE, PATCH } from "./[id]/route";
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
  const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-accounts-api-"));
  dirs.push(dir);
  process.env.LEAFCODE_PI_DATA_DIR = dir;
  return dir;
}

function jsonRequest(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function idContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function responseJson(response: Response) {
  return (await response.json()) as Record<string, unknown>;
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

describe("/api/accounts", () => {
  it("creates via POST and lists via GET", async () => {
    tempDataDir();

    const created = await responseJson(
      await POST(
        jsonRequest("http://localhost/api/accounts", "POST", {
          label: "仕事用",
          providers: ["openai-codex", "anthropic"],
          note: "メイン",
        }),
      ),
    );
    const account = created.account as {
      id: string;
      label: string;
      providers: string[];
    };
    assert.equal(account.label, "仕事用");
    assert.deepEqual(account.providers, ["openai-codex", "anthropic"]);

    const listed = await responseJson(await GET());
    assert.equal((listed.accounts as { id: string }[]).length, 1);
  });

  it("updates account order via PATCH", async () => {
    tempDataDir();
    const createdIds: string[] = [];
    for (const label of ["first", "second", "third"]) {
      const body = await responseJson(
        await POST(
          jsonRequest("http://localhost/api/accounts", "POST", {
            label,
            providers: ["openai-codex"],
          }),
        ),
      );
      createdIds.push((body.account as { id: string }).id);
    }

    const response = await PATCH_ACCOUNTS(
      jsonRequest("http://localhost/api/accounts", "PATCH", {
        accountOrder: [createdIds[2], createdIds[0], createdIds[1]],
      }),
    );
    assert.equal(response.status, 200);
    const body = await responseJson(response);
    assert.deepEqual(
      (body.accounts as { id: string }[]).map((account) => account.id),
      [createdIds[2], createdIds[0], createdIds[1]],
    );

    const invalid = await PATCH_ACCOUNTS(
      jsonRequest("http://localhost/api/accounts", "PATCH", {
        accountOrder: [createdIds[0], createdIds[0], createdIds[1]],
      }),
    );
    assert.equal(invalid.status, 400);
  });

  it("returns 400 on invalid body or validation failure", async () => {
    tempDataDir();

    const emptyBody = await POST(
      jsonRequest("http://localhost/api/accounts", "POST"),
    );
    assert.equal(emptyBody.status, 400);

    const noLabel = await responseJson(
      await POST(
        jsonRequest("http://localhost/api/accounts", "POST", {
          providers: ["openai-codex"],
        }),
      ),
    );
    assert.ok(typeof noLabel.error === "string");

    const badProvider = await POST(
      jsonRequest("http://localhost/api/accounts", "POST", {
        label: "x",
        providers: ["not-a-provider"],
      }),
    );
    assert.equal(badProvider.status, 400);
  });

  it("patches label and note but refuses providers changes", async () => {
    tempDataDir();
    const created = await responseJson(
      await POST(
        jsonRequest("http://localhost/api/accounts", "POST", {
          label: "before",
          providers: ["anthropic"],
        }),
      ),
    );
    const id = (created.account as { id: string }).id;

    const patched = await responseJson(
      await PATCH(
        jsonRequest(`http://localhost/api/accounts/${id}`, "PATCH", {
          label: "after",
        }),
        idContext(id),
      ),
    );
    assert.equal((patched.account as { label: string }).label, "after");

    const refused = await PATCH(
      jsonRequest(`http://localhost/api/accounts/${id}`, "PATCH", {
        providers: ["openai-codex"],
      }),
      idContext(id),
    );
    assert.equal(refused.status, 400);

    const emptyPatch = await PATCH(
      jsonRequest(`http://localhost/api/accounts/${id}`, "PATCH", {}),
      idContext(id),
    );
    assert.equal(emptyPatch.status, 400);

    const missing = await PATCH(
      jsonRequest("http://localhost/api/accounts/missing", "PATCH", {
        label: "x",
      }),
      idContext("missing"),
    );
    assert.equal(missing.status, 404);
  });

  it("deletes and returns 404 afterwards / 409 while a working task references it", async () => {
    tempDataDir();
    const project = upsertProject({
      name: "demo",
      rootPath: join(tmpdir(), "demo-root"),
    });
    const task = insertTask({ project, title: "running task" });

    const created = await responseJson(
      await POST(
        jsonRequest("http://localhost/api/accounts", "POST", {
          label: "busy",
          providers: ["openai-codex"],
        }),
      ),
    );
    const id = (created.account as { id: string }).id;

    // 実行中タスクからの参照が無ければ削除できる
    const first = await DELETE(
      new NextRequest(`http://localhost/api/accounts/${id}`),
      idContext(id),
    );
    assert.equal(first.status, 200);

    const busy = await responseJson(
      await POST(
        jsonRequest("http://localhost/api/accounts", "POST", {
          label: "busy2",
          providers: ["openai-codex"],
        }),
      ),
    );
    const busyId = (busy.account as { id: string }).id;
    assert.ok(patchLoose(task.id, { status: "working", accountId: busyId }));

    const conflict = await DELETE(
      new NextRequest(`http://localhost/api/accounts/${busyId}`),
      idContext(busyId),
    );
    assert.equal(conflict.status, 409);

    // 実行中参照が外れれば削除できる
    patchLoose(task.id, { status: "idle" });
    const second = await DELETE(
      new NextRequest(`http://localhost/api/accounts/${busyId}`),
      idContext(busyId),
    );
    assert.equal(second.status, 200);

    const gone = await DELETE(
      new NextRequest(`http://localhost/api/accounts/${busyId}`),
      idContext(busyId),
    );
    assert.equal(gone.status, 404);
  });
});
