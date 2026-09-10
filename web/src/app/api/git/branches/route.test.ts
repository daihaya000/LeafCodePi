import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  gitDirectoryError: vi.fn(),
  runGit: vi.fn(),
}));
vi.mock("@/lib/git", () => ({
  gitDirectoryError: mocks.gitDirectoryError,
  runGit: mocks.runGit,
}));

import { GET } from "./route";

import { NextRequest } from "next/server";

function agentRequest(directory: string | null = "C:/work"): NextRequest {
  const url = new URL("http://localhost/api/git/branches");
  if (directory !== null) url.searchParams.set("directory", directory);
  return { nextUrl: url } as NextRequest;
}

function gitResult(code: number, stdout = "", stderr = "") {
  return { code, stdout, stderr };
}

describe("GET /api/git/branches", () => {
  it("returns the current branch, upstream, ahead count, and remotes", async () => {
    mocks.gitDirectoryError.mockReturnValue(null);
    mocks.runGit.mockImplementation((_dir: string, args: string[]) => {
      if (args[0] === "rev-parse" && args.includes("@{u}")) {
        return Promise.resolve(gitResult(0, "origin/feature/x\n"));
      }
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return Promise.resolve(gitResult(0, "feature/x\n"));
      }
      if (args[0] === "branch") {
        return Promise.resolve(gitResult(0, "main\nfeature/x\n"));
      }
      if (args[0] === "rev-list") {
        return Promise.resolve(gitResult(0, "3\n"));
      }
      if (args[0] === "remote") {
        return Promise.resolve(gitResult(0, "origin\n"));
      }
      throw new Error(`unexpected args: ${args.join(" ")}`);
    });

    const response = await GET(agentRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      current: "feature/x",
      branches: ["main", "feature/x"],
      defaultTarget: "main",
      upstream: "origin/feature/x",
      ahead: 3,
      remotes: ["origin"],
      hasRemote: true,
    });
  });

  it("falls back to main/master when there is no upstream", async () => {
    mocks.gitDirectoryError.mockReturnValue(null);
    mocks.runGit.mockImplementation((_dir: string, args: string[]) => {
      if (args[0] === "rev-parse" && args.includes("@{u}")) {
        return Promise.resolve(gitResult(1, "", "fatal: no upstream"));
      }
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return Promise.resolve(gitResult(0, "feature/x\n"));
      }
      if (args[0] === "branch") {
        return Promise.resolve(gitResult(0, "master\nfeature/x\n"));
      }
      if (args[0] === "rev-list") {
        return Promise.resolve(gitResult(1, "", "fatal: no upstream"));
      }
      if (args[0] === "remote") {
        return Promise.resolve(gitResult(0, ""));
      }
      throw new Error(`unexpected args: ${args.join(" ")}`);
    });

    const response = await GET(agentRequest());
    expect(await response.json()).toMatchObject({
      current: "feature/x",
      defaultTarget: "master",
      upstream: null,
      ahead: -1,
      hasRemote: false,
    });
  });

  it("does not suggest the current branch as a merge target", async () => {
    mocks.gitDirectoryError.mockReturnValue(null);
    mocks.runGit.mockImplementation((_dir: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return Promise.resolve(gitResult(0, "main\n"));
      }
      if (args[0] === "branch") {
        return Promise.resolve(gitResult(0, "main\n"));
      }
      return Promise.resolve(gitResult(1, ""));
    });

    const response = await GET(agentRequest());
    expect(await response.json()).toMatchObject({
      current: "main",
      defaultTarget: null,
    });
  });

  it("returns 403 for disallowed directories and 400 for missing git repos", async () => {
    mocks.gitDirectoryError.mockReturnValue("directory is not allowed");
    expect((await GET(agentRequest("C:/outside"))).status).toBe(403);

    mocks.gitDirectoryError.mockReturnValue(null);
    mocks.runGit.mockResolvedValue(gitResult(128, "", "fatal: not a git repository"));
    const response = await GET(agentRequest());
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("not a git repository");
  });
});