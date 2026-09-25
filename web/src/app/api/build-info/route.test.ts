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
  it("returns the latest local commit and timestamp", async () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const committedAt = "2026-09-25T11:30:00+09:00";
    runGit.mockResolvedValue({ code: 0, stdout: `${commit}\n${committedAt}\n`, stderr: "" });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ commit, committedAt });
    expect(runGit).toHaveBeenCalledWith(repoRoot, ["log", "-1", "--format=%H%n%cI"], 2_000);
  });

  it("returns unavailable when the latest commit cannot be read", async () => {
    runGit.mockResolvedValue({ code: 1, stdout: "", stderr: "not a git repository" });

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ commit: null, committedAt: null });
  });
});
