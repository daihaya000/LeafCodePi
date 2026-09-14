import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { accountStoredProviders } from "@/lib/accounts";
import { roamingConfigDir } from "./app-paths";
import { defaultOpenCodeCookiePath } from "./browser-cookies";
import { loadCodexBarConfig } from "./codexbar-config";
import { codexBarConfigDir } from "./netscape-cookies";
import { readPiApiKey, readPiOAuthTokens } from "./pi-auth";
import {
  createCursorProvider,
  cursorAuthJsonPath,
  cursorStateDbPath,
} from "./providers/cursor";

describe("roamingConfigDir", () => {
  it("prefers APPDATA when set, matching existing CodexBar tests", () => {
    expect(
      roamingConfigDir({ APPDATA: "/tmp/isolated-appdata" }, "linux"),
    ).toBe("/tmp/isolated-appdata");
    expect(
      roamingConfigDir({ APPDATA: "C:\\Roaming" }, "win32"),
    ).toBe("C:\\Roaming");
  });

  it("does not invent ~/AppData/Roaming on Linux", () => {
    const env = { HOME: homedir() } as NodeJS.ProcessEnv;
    delete env.APPDATA;
    delete env.XDG_CONFIG_HOME;
    expect(roamingConfigDir(env, "linux")).toBe(join(homedir(), ".config"));
    expect(roamingConfigDir(env, "linux")).not.toContain("AppData");
  });

  it("uses XDG_CONFIG_HOME on Linux when APPDATA is unset", () => {
    expect(
      roamingConfigDir({ XDG_CONFIG_HOME: "/xdg/config" }, "linux"),
    ).toBe("/xdg/config");
  });

  it("uses Application Support on macOS and Roaming on Windows", () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(roamingConfigDir(env, "darwin")).toBe(
      join(homedir(), "Library", "Application Support"),
    );
    expect(roamingConfigDir(env, "win32")).toBe(
      join(homedir(), "AppData", "Roaming"),
    );
  });
});

describe("CodexBar and Cursor config paths on Linux", () => {
  it("places CodexBar config under the platform config root", () => {
    const previous = process.env.APPDATA;
    delete process.env.APPDATA;
    delete process.env.XDG_CONFIG_HOME;
    try {
      if (process.platform === "win32") {
        expect(codexBarConfigDir()).toBe(
          join(homedir(), "AppData", "Roaming", "CodexBar"),
        );
        return;
      }
      expect(codexBarConfigDir()).toBe(join(homedir(), ".config", "CodexBar"));
      expect(defaultOpenCodeCookiePath()).toBe(
        join(homedir(), ".config", "CodexBar", "opencode_cookies.txt"),
      );
      expect(cursorAuthJsonPath()).toBe(
        join(homedir(), ".config", "Cursor", "auth.json"),
      );
      expect(cursorStateDbPath()).toBe(
        join(
          homedir(),
          ".config",
          "Cursor",
          "User",
          "globalStorage",
          "state.vscdb",
        ),
      );
    } finally {
      if (previous === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = previous;
    }
  });

  it("does not crash when CodexBar config and Pi auth.json are absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-linux-auth-smoke-"));
    const previousAppData = process.env.APPDATA;
    const previousAgent = process.env.PI_CODING_AGENT_DIR;
    process.env.APPDATA = dir;
    process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
    try {
      expect(loadCodexBarConfig()).toEqual({});
      expect(readPiOAuthTokens("openai-codex")).toBeNull();
      expect(readPiOAuthTokens("anthropic")).toBeNull();
      expect(readPiOAuthTokens("cursor")).toBeNull();
      expect(readPiApiKey("ollama-cloud")).toBeNull();
      expect(accountStoredProviders("missing", join(dir, "agent"))).toEqual([]);
      const cursor = createCursorProvider({
        key: "default",
        kind: "default",
        accountId: null,
        accountLabel: null,
        authPath: null,
      });
      expect(() => cursor.isConfigured()).not.toThrow();
      expect(cursor.isConfigured()).toBe(false);
    } finally {
      if (previousAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = previousAppData;
      if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgent;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
