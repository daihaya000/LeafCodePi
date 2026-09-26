import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setSetting } from "@/lib/pi/web-settings";
import {
  codePermissionUpdates,
  followsCodePermissionMode,
  readCodePermissionMode,
  readCodeSkillPermission,
  readCodeSubagentPermission,
} from "./code-permission-settings";

const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;

describe("Code permission settings", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "leafcode-code-permissions-"));
    process.env.LEAFCODE_PI_DATA_DIR = root;
  });

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
    else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  });

  it("uses allow / allow / deny until Settings store a value", () => {
    expect(readCodePermissionMode()).toBe("allow");
    expect(readCodeSkillPermission()).toBe("allow");
    expect(readCodeSubagentPermission()).toBe("deny");
  });

  it("reads the values saved in Settings", () => {
    setSetting("code-permission-mode", "ask");
    setSetting("code-skill-permission", "deny");
    setSetting("code-subagent-permission", "allow");

    expect(readCodePermissionMode()).toBe("ask");
    expect(readCodeSkillPermission()).toBe("deny");
    expect(readCodeSubagentPermission()).toBe("allow");
  });

  it("returns only the values a user Code task has not applied", () => {
    setSetting("code-permission-mode", "ask");
    setSetting("code-skill-permission", "deny");

    expect(codePermissionUpdates({ kind: "code", permissionMode: "allow" })).toEqual({
      permissionMode: "ask",
      skillPermission: "deny",
    });
    expect(codePermissionUpdates({ kind: "code", permissionMode: "ask", skillPermission: "deny" })).toEqual({});
  });

  it("treats a missing skill permission on old tasks as allowed", () => {
    expect(codePermissionUpdates({ permissionMode: "allow" })).toEqual({});
  });

  it("keeps the approval mode of Bot-started and Bot-supervised Code tasks", () => {
    setSetting("code-permission-mode", "deny");
    setSetting("code-skill-permission", "deny");

    expect(followsCodePermissionMode({ kind: "code", botId: "bot-1" })).toBe(false);
    expect(followsCodePermissionMode({ kind: "code", supervisorBotId: "bot-1" })).toBe(false);
    expect(codePermissionUpdates({ kind: "code", botId: "bot-1", permissionMode: "ask" })).toEqual({
      skillPermission: "deny",
    });
    expect(codePermissionUpdates({ kind: "code", supervisorBotId: "bot-1", permissionMode: "ask" })).toEqual({
      skillPermission: "deny",
    });
  });

  it("never applies Code settings to Bot conversations", () => {
    setSetting("code-permission-mode", "deny");
    setSetting("code-skill-permission", "deny");

    expect(codePermissionUpdates({ kind: "bot", botId: "bot-1", permissionMode: "allow" })).toEqual({});
  });
});
