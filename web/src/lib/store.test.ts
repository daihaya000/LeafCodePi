import { describe, expect, it } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("store", () => {
  it("round-trips a project and task", async () => {
    const dir = join(tmpdir(), `leafcode-pi-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const { upsertProject, insertTask, listProjects, listTasks } = await import("./store");
    const project = upsertProject({ name: "demo", rootPath: "C:\\tmp\\demo" });
    insertTask({ project, title: "hello" });
    expect(listProjects()).toHaveLength(1);
    expect(listTasks()[0]?.title).toBe("hello");
    rmSync(dir, { recursive: true, force: true });
  });
});
