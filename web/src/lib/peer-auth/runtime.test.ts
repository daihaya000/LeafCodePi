import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { storedProviderTypes } from "./runtime";

const dirs: string[] = [];
function authFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "leafcode-peer-runtime-"));
  dirs.push(dir);
  const path = join(dir, "auth.json");
  writeFileSync(path, content, "utf8");
  return path;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("storedProviderTypes", () => {
  it("lists provider ids and kinds without exposing values", () => {
    const path = authFile(JSON.stringify({
      anthropic: { type: "oauth", access: "SECRET", refresh: "SECRET", expires: 1 },
      openrouter: { type: "api_key", key: "SECRET" },
      odd: { type: "other" },
      broken: null,
    }));
    const result = storedProviderTypes(path);
    expect(result).toEqual([
      { providerId: "anthropic", type: "oauth" },
      { providerId: "openrouter", type: "api_key" },
    ]);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("returns an empty list for missing, malformed or non-object files", () => {
    expect(storedProviderTypes(join(tmpdir(), "leafcode-peer-missing", "auth.json"))).toEqual([]);
    expect(storedProviderTypes(authFile("{nope"))).toEqual([]);
    expect(storedProviderTypes(authFile("[]"))).toEqual([]);
    expect(storedProviderTypes(authFile("null"))).toEqual([]);
  });
});
