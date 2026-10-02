import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, vi } from "vitest";

const undiciFetch = vi.hoisted(() => vi.fn());

vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
  fetch: undiciFetch,
}));

import {
  createOpenCodeGoProvider,
  parseOpenCodeGoStatus,
  parseOpenCodeGoWorkspaceIds,
  readAccountOpenCodeGoWorkspace,
} from "./opencode-go";

const tempDirs: string[] = [];

const statusJson = JSON.stringify({
  access: {
    startsAt: "2026-09-17T21:10:09.000Z",
    endsAt: "2026-10-17T21:10:09.000Z",
    meters: {
      fiveHour: {
        startsAt: "2026-09-20T12:10:09.000Z",
        resetsAt: "2026-09-20T17:10:09.000Z",
        limitMicroCents: "1000000",
        usedMicroCents: "125000",
      },
      week: {
        startsAt: "2026-09-14T09:00:00.000Z",
        resetsAt: "2026-09-21T09:00:00.000Z",
        limitMicroCents: 1000000,
        usedMicroCents: 760000,
      },
      month: {
        limitMicroCents: "1000000",
        usedMicroCents: "380000",
      },
    },
  },
});

const cookieText = `# Netscape HTTP Cookie File
opencode.ai\tFALSE\t/\tTRUE\t4102444800\t__Host-console_session\ttest-session
`;

function setupAccount(
  workspaceId: string | null = "wrk_01KVW89M1GY45TQC5HF9YT5TWR",
): string {
  const dir = mkdtempSync(join(tmpdir(), "leafcode-opencode-go-"));
  tempDirs.push(dir);
  const authPath = join(dir, "auth.json");
  writeFileSync(authPath, "{}\n", "utf8");
  writeFileSync(join(dir, "opencode-cookies.txt"), cookieText, "utf8");
  if (workspaceId) {
    writeFileSync(
      join(dir, "opencode-go.json"),
      JSON.stringify({ workspaceId }),
      "utf8",
    );
  }
  return authPath;
}

afterEach(() => {
  undiciFetch.mockReset();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("parseOpenCodeGoWorkspaceIds", () => {
  it("extracts valid Console workspace and organization IDs", () => {
    assert.deepEqual(
      parseOpenCodeGoWorkspaceIds(
        JSON.stringify([
          { id: "not-an-org-id" },
          { id: "wrk_01KVW89M1GY45TQC5HF9YT5TWR" },
          { id: "org_01KVW89M1GY45TQC5HF9YT5TWR" },
          { name: "missing id" },
        ]),
      ),
      [
        "wrk_01KVW89M1GY45TQC5HF9YT5TWR",
        "org_01KVW89M1GY45TQC5HF9YT5TWR",
      ],
    );
    assert.deepEqual(parseOpenCodeGoWorkspaceIds("not json"), []);
  });
});

describe("parseOpenCodeGoStatus", () => {
  it("parses Console meters and uses the subscription end for monthly reset", () => {
    const { windows } = parseOpenCodeGoStatus(statusJson);

    assert.deepEqual(
      windows.map((window) => ({
        id: window.id,
        usedPercent: window.usedPercent,
        resetsAt: window.resetsAt?.toISOString(),
        windowDurationMs: window.windowDurationMs,
      })),
      [
        {
          id: "opencode-go-rolling",
          usedPercent: 12.5,
          resetsAt: "2026-09-20T17:10:09.000Z",
          windowDurationMs: 18_000_000,
        },
        {
          id: "opencode-go-weekly",
          usedPercent: 76,
          resetsAt: "2026-09-21T09:00:00.000Z",
          windowDurationMs: 604_800_000,
        },
        {
          id: "opencode-go-monthly",
          usedPercent: 38,
          resetsAt: "2026-10-17T21:10:09.000Z",
          windowDurationMs: 2_592_000_000,
        },
      ],
    );
  });
});

describe("createOpenCodeGoProvider", () => {
  it("discovers and persists a workspace ID from the Console orgs API", async () => {
    undiciFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([{ id: "wrk_01KVW89M1GY45TQC5HF9YT5TWR" }]),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(statusJson, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const authPath = setupAccount(null);
    const provider = createOpenCodeGoProvider({
      key: "account:opencode",
      kind: "account",
      accountId: "opencode",
      accountLabel: "OpenCode",
      authPath,
    });

    const snapshot = await provider.fetch();

    assert.equal(snapshot.windows[1].usedPercent, 76);
    assert.equal(
      readAccountOpenCodeGoWorkspace(authPath),
      "wrk_01KVW89M1GY45TQC5HF9YT5TWR",
    );
    const [orgsUrl, orgsInit] = undiciFetch.mock.calls[0] as [
      string,
      RequestInit,
    ];
    assert.equal(orgsUrl, "https://opencode.ai/console/api/orgs");
    assert.equal(
      (orgsInit.headers as Record<string, string>).Cookie,
      "__Host-console_session=test-session",
    );
    const [statusUrl, statusInit] = undiciFetch.mock.calls[1] as [
      string,
      RequestInit,
    ];
    assert.equal(statusUrl, "https://opencode.ai/console/api/go/status");
    assert.equal(
      (statusInit.headers as Record<string, string>)["x-org-id"],
      "wrk_01KVW89M1GY45TQC5HF9YT5TWR",
    );
  });

  it("calls the Console API with the workspace scope header", async () => {
    undiciFetch.mockResolvedValue(
      new Response(statusJson, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const authPath = setupAccount();
    const provider = createOpenCodeGoProvider({
      key: "account:opencode",
      kind: "account",
      accountId: "opencode",
      accountLabel: "OpenCode",
      authPath,
    });

    const snapshot = await provider.fetch();

    assert.equal(snapshot.windows[1].usedPercent, 76);
    const [url, init] = undiciFetch.mock.calls[0] as [string, RequestInit];
    assert.equal(url, "https://opencode.ai/console/api/go/status");
    const headers = init.headers as Record<string, string>;
    assert.equal(headers["x-org-id"], "wrk_01KVW89M1GY45TQC5HF9YT5TWR");
    assert.equal(
      headers.Referer,
      "https://opencode.ai/console/wrk_01KVW89M1GY45TQC5HF9YT5TWR/go",
    );
  });
});
