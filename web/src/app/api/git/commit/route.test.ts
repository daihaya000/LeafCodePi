import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  commitPathError: vi.fn(() => null),
  gitDirectoryError: vi.fn(() => null),
  runGit: vi.fn(),
  getSetting: vi.fn((): string | null => null),
  getMachineName: vi.fn(() => "x870"),
}));

vi.mock("@/lib/git", () => mocks);
vi.mock("@/lib/machine-name", () => ({ getMachineName: mocks.getMachineName }));
vi.mock("@/lib/pi/web-settings", () => ({ getSetting: mocks.getSetting }));

import { POST } from "@backend-runtime/json-business/handlers/git/commit/route";

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/git/commit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/git/commit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.gitDirectoryError.mockReturnValue(null);
    mocks.commitPathError.mockReturnValue(null);
    mocks.getSetting.mockReturnValue(null);
    mocks.getMachineName.mockReturnValue("x870");
    mocks.runGit.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  });

  it("commits a staged rename without including unrelated staged or new files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-selected-commit-"));
    const { runGit } = await vi.importActual<typeof import("@/lib/git")>("@/lib/git");
    const run: typeof runGit = (cwd, args, timeout, env) => runGit(cwd, [
      "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
      "-c", "commit.gpgSign=false", "-c", `core.hooksPath=${join(dir, "no-hooks")}`, ...args,
    ], timeout, env);
    try {
      expect((await run(dir, ["init"])).code).toBe(0);
      writeFileSync(join(dir, "old.txt"), "same\n");
      writeFileSync(join(dir, "other.txt"), "before\n");
      expect((await run(dir, ["add", "."])).code).toBe(0);
      expect((await run(dir, ["commit", "-m", "initial"])).code).toBe(0);
      expect((await run(dir, ["mv", "old.txt", "new.txt"])).code).toBe(0);
      writeFileSync(join(dir, "other.txt"), "after\n");
      expect((await run(dir, ["add", "other.txt"])).code).toBe(0);
      writeFileSync(join(dir, "late.txt"), "not selected\n");
      mocks.runGit.mockImplementation(run);

      const response = await POST(request({ directory: dir, message: "rename", paths: ["old.txt", "new.txt"] }));
      expect(await response.json()).toMatchObject({ ok: true });
      expect((await run(dir, ["ls-tree", "--name-only", "HEAD"])).stdout).toBe("new.txt\nother.txt\n");
      expect((await run(dir, ["show", "HEAD:other.txt"])).stdout).toBe("before\n");
      expect((await run(dir, ["status", "--porcelain"])).stdout).toContain("?? late.txt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("commits a deletion-only path selection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-selected-delete-"));
    const { runGit } = await vi.importActual<typeof import("@/lib/git")>("@/lib/git");
    const run: typeof runGit = (cwd, args, timeout, env) => runGit(cwd, [
      "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
      "-c", "commit.gpgSign=false", "-c", `core.hooksPath=${join(dir, "no-hooks")}`, ...args,
    ], timeout, env);
    try {
      expect((await run(dir, ["init"])).code).toBe(0);
      writeFileSync(join(dir, "keep.txt"), "keep\n");
      writeFileSync(join(dir, "gone.txt"), "gone\n");
      expect((await run(dir, ["add", "."])).code).toBe(0);
      expect((await run(dir, ["commit", "-m", "initial"])).code).toBe(0);
      const { unlinkSync } = await import("node:fs");
      unlinkSync(join(dir, "gone.txt"));
      mocks.runGit.mockImplementation(run);

      const response = await POST(request({ directory: dir, message: "delete gone", paths: ["gone.txt"] }));
      expect(await response.json()).toMatchObject({ ok: true });
      expect((await run(dir, ["ls-tree", "--name-only", "HEAD"])).stdout).toBe("keep.txt\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a non-string agent before invoking git", async () => {
    const response = await POST(
      request({ directory: "C:\\work", message: "commit", paths: ["src/app.ts"], agent: 123 }),
    );

    expect(response.status).toBe(400);
    expect(mocks.runGit).not.toHaveBeenCalled();
  });

  it("rejects a non-array paths value before invoking git", async () => {
    const response = await POST(
      request({ directory: "C:\\work", message: "commit", paths: "src/app.ts" }),
    );

    expect(response.status).toBe(400);
    expect(mocks.runGit).not.toHaveBeenCalled();
  });

  it("rejects a non-string commit message before invoking git", async () => {
    const response = await POST(
      request({ directory: "C:\\work", message: 123, paths: ["src/app.ts"] }),
    );

    expect(response.status).toBe(400);
    expect(mocks.runGit).not.toHaveBeenCalled();
  });

  it("rejects a non-string directory before invoking git", async () => {
    const response = await POST(
      request({ directory: 123, message: "commit", paths: ["src/app.ts"] }),
    );

    expect(response.status).toBe(400);
    expect(mocks.runGit).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean all flag before invoking git", async () => {
    const response = await POST(
      request({ directory: "C:\\work", message: "commit", paths: ["src/app.ts"], all: "false" }),
    );

    expect(response.status).toBe(400);
    expect(mocks.runGit).not.toHaveBeenCalled();
  });

  it("uses the agent name and machine-specific address by default", async () => {
    const response = await POST(
      request({ directory: "C:\\work", message: "commit", paths: ["src/app.ts"], agent: "default" }),
    );

    expect(response.status).toBe(200);
    const commitCall = mocks.runGit.mock.calls.find(([, args]) => args.includes("commit"));
    expect(commitCall?.[3]).toEqual({
      GIT_AUTHOR_NAME: "default",
      GIT_AUTHOR_EMAIL: "default@leafcodepi.x870",
      GIT_COMMITTER_NAME: "default",
      GIT_COMMITTER_EMAIL: "default@leafcodepi.x870",
    });
  });

  it("uses the configured author templates", async () => {
    mocks.getSetting.mockReturnValue(JSON.stringify({
      nameTemplate: "LeafCodePi ({agent})",
      emailTemplate: "{agent}@leafcodepi.{machine}",
    }));

    const response = await POST(
      request({ directory: "C:\\work", message: "commit", paths: ["src/app.ts"], agent: "reviewer" }),
    );

    expect(response.status).toBe(200);
    const commitCall = mocks.runGit.mock.calls.find(([, args]) => args.includes("commit"));
    expect(commitCall?.[3]).toEqual({
      GIT_AUTHOR_NAME: "LeafCodePi (reviewer)",
      GIT_AUTHOR_EMAIL: "reviewer@leafcodepi.x870",
      GIT_COMMITTER_NAME: "LeafCodePi (reviewer)",
      GIT_COMMITTER_EMAIL: "reviewer@leafcodepi.x870",
    });
  });

  it("uses the fallback agent name when no agent is provided", async () => {
    await POST(request({ directory: "C:\\work", message: "commit", paths: ["src/app.ts"] }));

    const commitCall = mocks.runGit.mock.calls.find(([, args]) => args.includes("commit"));
    expect(commitCall?.[3]).toMatchObject({
      GIT_AUTHOR_NAME: "default",
      GIT_AUTHOR_EMAIL: "default@leafcodepi.x870",
    });
  });
});
