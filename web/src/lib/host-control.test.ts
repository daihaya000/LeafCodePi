import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ root: "" }));
vi.mock("@/lib/paths", () => ({ dataDir: () => store.root }));

import {
  DEFAULT_CONTROL_URL,
  hostLlamaServerPath,
  hostRestartPath,
  hostTranslationPath,
  hostWebUiAuthPath,
  isLoopbackControlUrl,
  readSettingValue,
  resolveHostControlUrl,
  settingsPath,
  writeSettingValue,
} from "./host-control";

beforeEach(() => {
  store.root = mkdtempSync(join(tmpdir(), "host-control-"));
});

afterEach(() => {
  rmSync(store.root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("isLoopbackControlUrl", () => {
  it("accepts loopback control URLs", () => {
    expect(isLoopbackControlUrl("http://127.0.0.1:18775")).toBe(true);
    expect(isLoopbackControlUrl("http://localhost:18775")).toBe(true);
    expect(isLoopbackControlUrl("http://[::1]:18775")).toBe(true);
    expect(isLoopbackControlUrl("https://127.0.0.2:8443")).toBe(true);
  });

  it("rejects non-loopback hosts, protocols, and malformed URLs", () => {
    expect(isLoopbackControlUrl("http://example.com:18775")).toBe(false);
    expect(isLoopbackControlUrl("http://100.64.0.10:18775")).toBe(false);
    expect(isLoopbackControlUrl("ftp://127.0.0.1:18775")).toBe(false);
    expect(isLoopbackControlUrl("not a url")).toBe(false);
    expect(isLoopbackControlUrl("")).toBe(false);
  });
});

function controlEnv(url?: string): NodeJS.ProcessEnv {
  return (url === undefined
    ? {}
    : { LEAFCODE_PI_HOST_CONTROL_URL: url }) as unknown as NodeJS.ProcessEnv;
}

describe("resolveHostControlUrl", () => {
  it("falls back to the default loopback URL", () => {
    expect(resolveHostControlUrl(controlEnv())).toBe(DEFAULT_CONTROL_URL);
  });

  it("uses a loopback env override and strips trailing slashes", () => {
    expect(resolveHostControlUrl(controlEnv("http://127.0.0.1:19000/"))).toBe(
      "http://127.0.0.1:19000",
    );
  });

  it("ignores an env override that is not loopback", () => {
    expect(resolveHostControlUrl(controlEnv("http://evil.example.com/"))).toBe(
      DEFAULT_CONTROL_URL,
    );
  });

  it("reads a loopback URL from host-control.json", () => {
    writeFileSync(
      join(store.root, "host-control.json"),
      JSON.stringify({ url: "http://127.0.0.9:19191" }),
    );
    expect(resolveHostControlUrl(controlEnv())).toBe("http://127.0.0.9:19191");
  });

  it("ignores a corrupt host-control.json", () => {
    writeFileSync(join(store.root, "host-control.json"), "{broken");
    expect(resolveHostControlUrl(controlEnv())).toBe(DEFAULT_CONTROL_URL);
  });
});

describe("control paths", () => {
  it("builds the action paths", () => {
    expect(hostLlamaServerPath("start")).toBe("/llama-server/start");
    expect(hostRestartPath("webui")).toBe("/restart/webui");
    expect(hostRestartPath("host")).toBe("/restart/host");
    expect(hostTranslationPath("translate")).toBe("/translation/translate");
    expect(hostWebUiAuthPath()).toBe("/webui/auth");
  });
});

describe("setting files", () => {
  it("round-trips a setting value", () => {
    const path = settingsPath("translation-api");
    expect(path.endsWith(join("settings", "translation-api.json"))).toBe(true);
    expect(readSettingValue("translation-api")).toBeNull();
    writeSettingValue("translation-api", "http://127.0.0.1:9999");
    expect(readSettingValue("translation-api")).toBe("http://127.0.0.1:9999");
  });

  it("returns null for missing or corrupt setting files", () => {
    expect(readSettingValue("missing")).toBeNull();
    mkdirSync(join(store.root, "settings"), { recursive: true });
    writeFileSync(join(store.root, "settings", "broken.json"), "{broken");
    expect(readSettingValue("broken")).toBeNull();
  });
});