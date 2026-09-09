// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
          skills: [{ id: "review", name: "review", enabled: true, codeEnabled: true, botEnabled: false, source: "pi" }],
          skillsDir: "C:/pi/skills",
        });
      }
      if (path === "/api/mcp") {
        return Promise.resolve({
          servers: [
            { id: "fxhoudini", name: "fxhoudini", enabled: true, source: "stdio" },
            { id: "blendermcp", name: "blendermcp", enabled: true, source: "stdio" },
            { id: "mayamcp", name: "mayamcp", enabled: true, source: "stdio" },
            { id: "metatrader", name: "metatrader", enabled: true, source: "stdio" },
            { id: "mt5-build", name: "mt5-build", enabled: false, source: "stdio" },
            { id: "comfy-mcp", name: "comfy-mcp", enabled: true, source: "stdio" },
          ],
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

    await screen.findByRole("switch", { name: "review（Code）を無効化" });
    await screen.findByRole("switch", { name: "fxhoudini を無効化" });

    for (const heading of ["スキル", "MCP サーバー"]) {
      const list = screen.getByRole("heading", { name: heading }).parentElement?.parentElement?.querySelector("ul");
      expect(list).not.toBeNull();
      expect(list?.className).not.toContain("max-h-");
      expect(list?.className).not.toContain("overflow-y-auto");
    }
  });

  it("CodeとBotの切替を別々のscopeとして保存する", async () => {
    sendJson.mockResolvedValue({
      skills: [{ id: "review", name: "review", enabled: true, codeEnabled: true, botEnabled: true, source: "pi" }],
    });
    render(<SkillsSettings scope="bot" />);

    const botToggle = await screen.findByRole("switch", { name: "review（Bot）を有効化" });
    fireEvent.click(botToggle);
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith(
      "/api/skills/review",
      { enabled: true, scope: "bot" },
      "PATCH",
    ));
  });

  it("各MCPサーバーの説明文を表示する", async () => {
    render(<McpSettings />);

    for (const description of [
      "リモート Houdini のシーン構築、シミュレーション、レンダリングを操作します。",
      "Blender Lab 公式 MCP で、リモート Blender のシーン・オブジェクト・ドキュメント・レンダリングを操作します。",
      "PatrickPalmer/MayaMCP で、リモート Maya のシーン構築・モデリング・マテリアルを操作します。",
      "MetaTrader 5 の口座・相場・注文・ポジションを確認・管理します。",
      "MQL4/MQL5 のコンパイル、静的検査、デプロイ、Strategy Tester、レポート解析を行います。",
      "ComfyUI で画像・動画・音声・3D生成、ワークフロー編集、ジョブ監視を行います。",
    ]) {
      expect(await screen.findByText(description)).toBeTruthy();
    }
  });
});
