import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_CONTROL_URL, isLoopbackControlUrl, resolveHostControlUrl } from "./host-http-client";
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "leafcode-host-discovery-")); vi.stubEnv("LEAFCODE_PI_DATA_DIR", root); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
it("keeps Host marker/override/default discovery independent of Backend business paths", () => {
  expect(resolveHostControlUrl({})).toBe(DEFAULT_CONTROL_URL);
  writeFileSync(join(root, "host-control.json"), JSON.stringify({ url: "http://127.0.0.1:19990/" }));
  expect(resolveHostControlUrl({})).toBe("http://127.0.0.1:19990");
  expect(resolveHostControlUrl({ LEAFCODE_PI_HOST_CONTROL_URL: "http://localhost:19991/" })).toBe("http://localhost:19991");
  expect(resolveHostControlUrl({ LEAFCODE_PI_HOST_CONTROL_URL: "https://outside.invalid" })).toBe("http://127.0.0.1:19990");
  writeFileSync(join(root, "host-control.json"), JSON.stringify({ url: "https://outside.invalid" })); expect(resolveHostControlUrl({})).toBe(DEFAULT_CONTROL_URL);
});
it("invalid capability-bearing configured or discovered origins fail closed instead of using a fallback Host", () => {
  for (const url of ["http://user:PRIVATE@localhost", "http://localhost/path", "http://localhost/?token=PRIVATE", "http://localhost/#token"]) {
    expect(() => resolveHostControlUrl({ LEAFCODE_PI_HOST_CONTROL_URL: url })).toThrow(/plain origin/);
    writeFileSync(join(root, "host-control.json"), JSON.stringify({ url }));
    expect(() => resolveHostControlUrl({})).toThrow(/plain origin/);
  }
});
it("accepts loopback only and refuses credentials even on loopback", () => {
  for (const url of ["http://localhost:19991", "https://127.12.1.3:80", "http://[::1]:99"]) expect(isLoopbackControlUrl(url)).toBe(true);
  for (const url of ["http://user:PRIVATE@localhost", "http://127.300.1.2", "file://localhost/a", "http://example.com", "invalid"]) expect(isLoopbackControlUrl(url)).toBe(false);
});
