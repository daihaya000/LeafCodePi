import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareWorkspaceMove } from "./workspace-move";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("prepareWorkspaceMove", () => {
  it("copies the workspace and removes the source on finalize", async () => {
    const root = mkdtempSync(join(tmpdir(), "leafcode-pi-move-"));
    roots.push(root);
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    writeFileSync(join(source, "result.txt"), "done\n", "utf8");

    const operation = await prepareWorkspaceMove(source, destination);
    expect(readFileSync(join(source, "result.txt"), "utf8")).toBe("done\n");
    expect(readFileSync(join(destination, "result.txt"), "utf8")).toBe("done\n");

    await operation.finalize();
    expect(existsSync(source)).toBe(false);
    expect(existsSync(join(destination, "result.txt"))).toBe(true);
  });

  it("rolls back to the original source and existing empty destination", async () => {
    const root = mkdtempSync(join(tmpdir(), "leafcode-pi-move-"));
    roots.push(root);
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    mkdirSync(destination);
    writeFileSync(join(source, "result.txt"), "done\n", "utf8");

    const operation = await prepareWorkspaceMove(source, destination);
    await operation.rollback();

    expect(existsSync(join(source, "result.txt"))).toBe(true);
    expect(readdirSync(destination)).toHaveLength(0);
  });

  it("rejects a non-empty destination", async () => {
    const root = mkdtempSync(join(tmpdir(), "leafcode-pi-move-"));
    roots.push(root);
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    mkdirSync(destination);
    writeFileSync(join(destination, "existing.txt"), "keep\n", "utf8");

    await expect(prepareWorkspaceMove(source, destination)).rejects.toThrow(
      "移動先は空のフォルダーを指定してください",
    );
  });
});
