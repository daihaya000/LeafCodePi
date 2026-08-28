import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcher = path.join(packageRoot, "bin", "c2c.js");
const compiledEntry = path.join(packageRoot, "dist", "cli", "index.js");

describe("CLI launcher", () => {
  it("loads the compiled entry on Windows-compatible paths", () => {
    expect(existsSync(launcher)).toBe(true);
    expect(existsSync(compiledEntry)).toBe(true);

    const result = spawnSync(process.execPath, [launcher, "--version"], {
      cwd: packageRoot,
      encoding: "utf8",
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("0.1.0");
  });
});
