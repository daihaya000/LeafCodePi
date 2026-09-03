// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpSettings } from "./McpSettings";
import { SkillsSettings } from "./SkillsSettings";

const { getJson, sendJson } = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
}));

vi.mock("@/lib/client", () => ({ getJson, sendJson }));

describe("拡張設定の一覧", () => {
  beforeEach(() => {
    getJson.mockImplementation((path: string) => {
      if (path === "/api/skills") {
        return Promise.resolve({
          skills: [{ id: "review", name: "review", enabled: true, source: "pi" }],
          skillsDir: "C:/pi/skills",
        });
      }
      if (path === "/api/mcp") {
        return Promise.resolve({
          servers: [{ id: "local", name: "local", enabled: true, source: "stdio" }],
          configPath: "C:/pi/mcp.json",
        });
      }
      return Promise.reject(new Error(`unexpected path: ${path}`));
    });
    sendJson.mockResolvedValue({});
  });

  afterEach(() => {
    cleanup();
    getJson.mockReset();
    sendJson.mockReset();
  });

  it("スキルとMCPを内部スクロールにせず全件表示する", async () => {
    render(
      <>
        <SkillsSettings />
        <McpSettings />
      </>,
    );

    await screen.findByRole("switch", { name: "review を無効化" });
    await screen.findByRole("switch", { name: "local を無効化" });

    for (const heading of ["スキル", "MCP サーバー"]) {
      const list = screen.getByRole("heading", { name: heading }).parentElement?.parentElement?.querySelector("ul");
      expect(list).not.toBeNull();
      expect(list?.className).not.toContain("max-h-");
      expect(list?.className).not.toContain("overflow-y-auto");
    }
  });
});
