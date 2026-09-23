import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { it, vi } from "vitest";
import leafcodeComputerUse from "./index";

it("registers the desktop extension only on Windows and Linux, without starting the helper", () => {
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
    platform.mockReturnValue("darwin");
    leafcodeComputerUse(api);
    assert.deepEqual([tools, commands, events], [[], [], []]);
    for (const os of ["win32", "linux"] as const) {
      tools.length = 0;
      platform.mockReturnValue(os);
      leafcodeComputerUse(api);
      assert.deepEqual(tools, ["find_roots", "observe_ui", "search_ui", "expand_ui", "inspect_ui", "act_ui", "read_text", "wait_for"]);
    }
    assert.ok(commands.includes("leafcode-computer-use"));
    assert.ok(events.includes("session_start"));
  } finally {
    platform.mockRestore();
  }
});
