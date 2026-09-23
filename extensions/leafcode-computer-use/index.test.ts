import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { it, vi } from "vitest";
import leafcodeComputerUse from "./index";

it("registers the desktop extension only on Windows, without starting the helper", () => {
  const tools: string[] = [];
  const commands: string[] = [];
  const events: string[] = [];
  const api = {
    registerTool: (tool: { name: string }) => tools.push(tool.name),
    registerCommand: (name: string) => commands.push(name),
    on: (name: string) => events.push(name),
  } as unknown as ExtensionAPI;
  const platform = vi.spyOn(process, "platform", "get");
  try {
    platform.mockReturnValue("linux");
    leafcodeComputerUse(api);
    assert.deepEqual([tools, commands, events], [[], [], []]);
    platform.mockReturnValue("win32");
    leafcodeComputerUse(api);
    assert.ok(tools.includes("observe_ui"));
    assert.ok(tools.includes("act_ui"));
    assert.ok(commands.includes("leafcode-computer-use"));
    assert.ok(events.includes("session_start"));
  } finally {
    platform.mockRestore();
  }
});
