import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getProject: vi.fn(), getTask: vi.fn() }));
vi.mock("@/lib/store", () => mocks);

import {
  MAX_WORKSPACE_ENTRIES,
  listWorkspaceEntries,
  readWorkspaceFile,
  resolveWorkspaceRoot,
  workspaceAttachmentName,
} from "./project-files";
import { MAX_PROMPT_FILE_NAME_CHARS, MAX_PROMPT_FILE_TOTAL_BYTES } from "./prompt-images";

/** シンボリックリンクは Windows の権限設定によっては作成できないため、実行時に判定する。 */
const symlinksSupported = (() => {
  const dir = mkdtempSync(join(tmpdir(), "leafcode-pf-probe-"));
  try {
    writeFileSync(join(dir, "target.txt"), "x\n");
    mkdirSync(join(dir, "target-dir"));
    symlinkSync(join(dir, "target.txt"), join(dir, "link.txt"));
    symlinkSync(join(dir, "target-dir"), join(dir, "link-dir"), "junction");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

let root = "";
let outside = "";
const tempDirs: string[] = [];

beforeEach(() => {
  mocks.getProject.mockReset();
  mocks.getTask.mockReset();
  root = mkdtempSync(join(tmpdir(), "leafcode-pf-root-"));
  outside = mkdtempSync(join(tmpdir(), "leafcode-pf-outside-"));
  tempDirs.push(root, outside);
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("resolveWorkspaceRoot", () => {
  it("uses the registered project root", () => {
    mocks.getProject.mockReturnValue({ id: "p1", rootPath: root, archived: false });
    expect(resolveWorkspaceRoot({ kind: "project", id: "p1" })).toEqual({ ok: true, root });
  });

  it("rejects unknown and archived projects", () => {
    mocks.getProject.mockReturnValue(undefined);
    expect(resolveWorkspaceRoot({ kind: "project", id: "p1" })).toMatchObject({
      ok: false,
      status: 404,
    });
    mocks.getProject.mockReturnValue({ id: "p1", rootPath: root, archived: true });
    expect(resolveWorkspaceRoot({ kind: "project", id: "p1" })).toMatchObject({
      ok: false,
      status: 409,
    });
  });

  it("prefers the project root for a task, else the task directory", () => {
    mocks.getProject.mockReturnValue({ id: "p1", rootPath: outside, archived: false });
    mocks.getTask.mockReturnValue({ id: "t1", projectId: "p1", directory: root, kind: "code" });
    expect(resolveWorkspaceRoot({ kind: "task", id: "t1" })).toEqual({ ok: true, root: outside });

    mocks.getTask.mockReturnValue({ id: "t2", projectId: null, directory: root, kind: "code" });
    expect(resolveWorkspaceRoot({ kind: "task", id: "t2" })).toEqual({ ok: true, root });
  });

  it("rejects Bot workspaces, unknown tasks, and archived projects on a task", () => {
    mocks.getTask.mockReturnValue({ id: "bot:1", projectId: null, directory: root, kind: "bot" });
    expect(resolveWorkspaceRoot({ kind: "task", id: "bot:1" })).toMatchObject({
      ok: false,
      status: 403,
    });

    mocks.getTask.mockReturnValue(undefined);
    expect(resolveWorkspaceRoot({ kind: "task", id: "t" })).toMatchObject({
      ok: false,
      status: 404,
    });

    mocks.getProject.mockReturnValue({ id: "p1", rootPath: root, archived: true });
    mocks.getTask.mockReturnValue({ id: "t3", projectId: "p1", directory: root, kind: "code" });
    expect(resolveWorkspaceRoot({ kind: "task", id: "t3" })).toMatchObject({
      ok: false,
      status: 409,
    });
  });
});

describe("listWorkspaceEntries", () => {
  it("lists folders first with relative paths and hides build output", () => {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "const a = 1;\n");
    writeFileSync(join(root, ".env.example"), "A=1\n");
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "node_modules", "x.js"), "x\n");
    mkdirSync(join(root, ".git"));

    const result = listWorkspaceEntries(root, "");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.listing.path).toBe("");
    expect(result.listing.parent).toBeNull();
    expect(result.listing.truncated).toBe(false);
    // ドットファイルは見せ、除外ディレクトリだけを落とす。
    expect(result.listing.entries.map((entry) => `${entry.kind}:${entry.path}`)).toEqual([
      "dir:src",
      "file:.env.example",
    ]);
  });

  it("walks into a subfolder and reports its parent", () => {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "const a = 1;\n");

    const result = listWorkspaceEntries(root, "src");
    expect(result.ok && result.listing.path).toBe("src");
    expect(result.ok && result.listing.parent).toBe("");
    expect(result.ok && result.listing.entries[0]).toMatchObject({
      path: "src/a.ts",
      kind: "file",
      size: 13,
    });
  });

  it("rejects traversal, absolute paths, excluded folders, and missing folders", () => {
    mkdirSync(join(root, "node_modules"));
    expect(listWorkspaceEntries(root, "../outside")).toMatchObject({ ok: false, status: 400 });
    expect(listWorkspaceEntries(root, "src/../../outside")).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(listWorkspaceEntries(root, "C:\\Windows")).toMatchObject({ ok: false, status: 400 });
    expect(listWorkspaceEntries(root, "/etc")).toMatchObject({ ok: false, status: 400 });
    expect(listWorkspaceEntries(root, "node_modules")).toMatchObject({ ok: false, status: 403 });
    expect(listWorkspaceEntries(root, "missing")).toMatchObject({ ok: false, status: 404 });
  });

  it("caps a folder that exceeds the entry limit", () => {
    for (let index = 0; index <= MAX_WORKSPACE_ENTRIES; index += 1) {
      writeFileSync(join(root, `f${String(index).padStart(4, "0")}.txt`), "x\n");
    }

    const result = listWorkspaceEntries(root, "");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.listing.entries).toHaveLength(MAX_WORKSPACE_ENTRIES);
    expect(result.listing.truncated).toBe(true);
  });

  it.skipIf(!symlinksSupported)("hides symlinks and refuses to follow them", () => {
    writeFileSync(join(outside, "secret.txt"), "secret\n");
    mkdirSync(join(outside, "dir"));
    writeFileSync(join(outside, "dir", "secret.txt"), "secret\n");
    symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
    symlinkSync(join(outside, "dir"), join(root, "linkdir"), "junction");

    const result = listWorkspaceEntries(root, "");
    expect(result.ok && result.listing.entries).toEqual([]);
    expect(listWorkspaceEntries(root, "linkdir")).toMatchObject({ ok: false, status: 404 });
    expect(readWorkspaceFile(root, "link.txt")).toMatchObject({ ok: false, status: 404 });
    // リンク先の実体がルート外なので、途中のリンクを経由した読み込みも拒否する。
    expect(readWorkspaceFile(root, "linkdir/secret.txt")).toMatchObject({
      ok: false,
      status: 404,
    });
  });
});

describe("readWorkspaceFile", () => {
  it("returns base64 UTF-8 text with a relative attachment name", () => {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "メモ.txt"), "日本語のメモ\n");

    const result = readWorkspaceFile(root, "src/メモ.txt");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.name).toBe("src/メモ.txt");
    expect(result.file.mimeType).toBe("text/plain");
    expect(Buffer.from(result.file.data, "base64").toString("utf8")).toBe("日本語のメモ\n");
    expect(result.file.size).toBe(Buffer.byteLength("日本語のメモ\n", "utf8"));
  });

  it("rejects binary, empty, oversized, excluded, and unsafe paths", () => {    writeFileSync(join(root, "binary.txt"), Buffer.from([0xff, 0xfe]));
    writeFileSync(join(root, "empty.txt"), "");
    writeFileSync(join(root, "big.txt"), "a".repeat(MAX_PROMPT_FILE_TOTAL_BYTES + 1));
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "node_modules", "x.js"), "x\n");

    expect(readWorkspaceFile(root, "binary.txt")).toMatchObject({ ok: false, status: 415 });
    expect(readWorkspaceFile(root, "empty.txt")).toMatchObject({ ok: false, status: 400 });
    expect(readWorkspaceFile(root, "big.txt")).toMatchObject({ ok: false, status: 413 });
    expect(readWorkspaceFile(root, "node_modules/x.js")).toMatchObject({ ok: false, status: 403 });
    expect(readWorkspaceFile(root, "")).toMatchObject({ ok: false, status: 400 });
    expect(readWorkspaceFile(root, "../outside/secret.txt")).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(readWorkspaceFile(root, "missing.txt")).toMatchObject({ ok: false, status: 404 });
  });

  it("allows a regular file whose name matches an excluded folder", () => {
    writeFileSync(join(root, "out"), "kept\n");

    const result = readWorkspaceFile(root, "out");
    expect(result.ok).toBe(true);
    expect(result.ok && result.file.name).toBe("out");
  });
});

describe("workspaceAttachmentName", () => {
  it("normalizes separators and truncates an over-long path from the head", () => {
    expect(workspaceAttachmentName("src\\a.ts")).toBe("src/a.ts");
    expect(workspaceAttachmentName("/src/a.ts")).toBe("src/a.ts");

    const long = `${"n".repeat(200)}/${"m".repeat(200)}.ts`;
    const name = workspaceAttachmentName(long);
    expect(Array.from(name)).toHaveLength(MAX_PROMPT_FILE_NAME_CHARS);
    expect(name.startsWith("…")).toBe(true);
    expect(long.endsWith(name.slice(1))).toBe(true);
  });
});
