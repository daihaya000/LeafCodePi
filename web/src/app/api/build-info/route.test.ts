import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runGit } = vi.hoisted(() => ({ runGit: vi.fn() }));
vi.mock("@/lib/git", () => ({ runGit }));

import { GET } from "./route";

const repoRoot = join(tmpdir(), "leafcode-build-info-test");
const originalSkillsDir = process.env.LEAFCODE_PI_SKILLS_DIR;

beforeEach(() => {
  process.env.LEAFCODE_PI_SKILLS_DIR = join(repoRoot, "skills");
  runGit.mockReset();
});

afterEach(() => {
  if (originalSkillsDir === undefined) delete process.env.LEAFCODE_PI_SKILLS_DIR;
  else process.env.LEAFCODE_PI_SKILLS_DIR = originalSkillsDir;
});

describe("GET /api/build-info", () => {
  it("returns the local latest commit and timestamp when upstream is current", async () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const committedAt = "2026-09-25T11:30:00+09:00";
    runGit
      .mockResolvedValueOnce({ code: 0, stdout: `${commit}\n${committedAt}\n`, stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "origin/master\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: `${commit}\trefs/heads/master\n`, stderr: "" });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ commit, committedAt, latestCommit: commit });
    expect(runGit).toHaveBeenNthCalledWith(1, repoRoot, ["log", "-1", "--format=%H%n%cI"], 2_000);
    expect(runGit).toHaveBeenNthCalledWith(
      2,
      repoRoot,
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
      2_000,
    );
    expect(runGit).toHaveBeenNthCalledWith(
      3,
      repoRoot,
      ["ls-remote", "--heads", "origin", "refs/heads/master"],
      5_000,
    );
  });

  it("warns against a newer remote tip", async () => {
    const localCommit = "a".repeat(40);
    const remoteCommit = "b".repeat(40);
    const committedAt = "2026-09-25T11:30:00+09:00";
    runGit
      .mockResolvedValueOnce({ code: 0, stdout: `${localCommit}\n${committedAt}\n`, stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "origin/master\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: `${remoteCommit}\trefs/heads/master\n`, stderr: "" })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "not an ancestor" });

    const response = await GET();

    expect(await response.json()).toEqual({ commit: localCommit, committedAt, latestCommit: remoteCommit });
  });

  it("keeps the local commit current when it is ahead of the remote", async () => {
    const localCommit = "a".repeat(40);
    const remoteCommit = "b".repeat(40);
    const committedAt = "2026-09-25T11:30:00+09:00";
    runGit
      .mockResolvedValueOnce({ code: 0, stdout: `${localCommit}\n${committedAt}\n`, stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "origin/master\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: `${remoteCommit}\trefs/heads/master\n`, stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

    const response = await GET();

    expect(await response.json()).toEqual({ commit: localCommit, committedAt, latestCommit: localCommit });
  });

  it("falls back to the local commit when the remote cannot be reached", async () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const committedAt = "2026-09-25T11:30:00+09:00";
    runGit
      .mockResolvedValueOnce({ code: 0, stdout: `${commit}\n${committedAt}\n`, stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "origin/master\n", stderr: "" })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "remote unavailable" });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ commit, committedAt, latestCommit: commit });
  });

  it("returns unavailable when the local commit cannot be read", async () => {
    runGit.mockResolvedValue({ code: 1, stdout: "", stderr: "not a git repository" });

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ commit: null, committedAt: null, latestCommit: null });
  });
});
