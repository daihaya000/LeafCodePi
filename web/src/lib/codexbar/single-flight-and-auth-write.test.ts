import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeBackPiOAuthTokens } from "./pi-auth";
import { singleFlight } from "./utils";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-auth-")); dirs.push(dir); return dir; };

describe("singleFlight", () => {
  it("runs one task per key for concurrent callers, then allows a new run", async () => {
    let runs = 0;
    const task = async () => { runs += 1; await new Promise((resolve) => setTimeout(resolve, 10)); return runs; };
    const [a, b] = await Promise.all([singleFlight("k", task), singleFlight("k", task)]);
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(await singleFlight("k", task)).toBe(2);
  });
});

describe("writeBackPiOAuthTokens", () => {
  it("merges into an existing auth.json without leaving temp files", async () => {
    const path = join(tempDir(), "auth.json");
    writeFileSync(path, JSON.stringify({ other: { type: "api_key", key: "k" } }));
    await writeBackPiOAuthTokens("openai-codex", { access: "a", refresh: "r" }, { authPath: path });
    const stored = JSON.parse(readFileSync(path, "utf8"));
    expect(stored.other).toEqual({ type: "api_key", key: "k" });
    expect(stored["openai-codex"]).toMatchObject({ access: "a", refresh: "r" });
    expect(readdirSync(join(path, "..")).filter((name) => name.endsWith(".tmp") || name.includes("leafcode-tmp"))).toEqual([]);
  });

  it("refuses to overwrite an unreadable auth.json", async () => {
    const path = join(tempDir(), "auth.json");
    writeFileSync(path, "{not json");
    await expect(writeBackPiOAuthTokens("openai-codex", { access: "a" }, { authPath: path })).rejects.toThrow(/unreadable/);
    expect(readFileSync(path, "utf8")).toBe("{not json");
  });
});
