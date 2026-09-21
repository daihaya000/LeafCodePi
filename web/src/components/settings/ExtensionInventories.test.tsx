// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
          skills: [
            { id: "review", name: "review", enabled: true, codeEnabled: true, botEnabled: false, source: "pi" },
            { id: "typesafe-ai", name: "typesafe-ai", enabled: true, codeEnabled: true, botEnabled: true, source: "bundled" },
          ],
          skillsDir: "C:/pi/skills",
          bundledSkillsDir: "C:/repo/skills",
        });
      }
      if (path === "/api/mcp") {
        return Promise.resolve({
          servers: [
            { id: "browser-use", name: "browser-use", enabled: true, bundled: true, userConfigured: false, source: "stdio" },
            { id: "n8n", name: "n8n", enabled: true, bundled: true, userConfigured: false, source: "http" },
            { id: "slack", name: "slack", enabled: true, bundled: true, userConfigured: false, source: "http" },
            { id: "notion", name: "notion", enabled: true, bundled: true, userConfigured: false, source: "http" },
            { id: "fxhoudini", name: "fxhoudini", enabled: true, bundled: false, userConfigured: true, source: "stdio" },
            { id: "blendermcp", name: "blendermcp", enabled: true, bundled: false, userConfigured: true, source: "stdio" },
            { id: "mayamcp", name: "mayamcp", enabled: true, bundled: false, userConfigured: true, source: "stdio" },
            { id: "metatrader", name: "metatrader", enabled: true, bundled: false, userConfigured: true, source: "stdio" },
            { id: "mt5-build", name: "mt5-build", enabled: false, bundled: false, userConfigured: true, source: "stdio" },
            { id: "comfy-mcp", name: "comfy-mcp", enabled: true, bundled: false, userConfigured: true, source: "stdio" },
            { id: "custom", name: "custom", enabled: true, bundled: false, userConfigured: true, source: "stdio" },
          ],
          configPath: "C:/pi/mcp.json",
          bundledConfigPath: "C:/repo/extensions/leafcode-mcp-adapter/mcp.json",
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

    expect(within(screen.getByTestId("skills-bundled")).getByText("typesafe-ai")).toBeTruthy();
    expect(within(screen.getByTestId("skills-bundled")).getByText("C:/repo/skills")).toBeTruthy();
    expect(within(screen.getByTestId("skills-user")).getByText("review")).toBeTruthy();
    expect(within(screen.getByTestId("skills-user")).getByText("C:/pi/skills")).toBeTruthy();
    expect(within(screen.getByTestId("mcp-bundled")).getByText("C:/repo/extensions/leafcode-mcp-adapter/mcp.json")).toBeTruthy();
    expect(within(screen.getByTestId("mcp-bundled")).getByText("browser-use")).toBeTruthy();
    expect(within(screen.getByTestId("mcp-bundled")).getByText("n8n")).toBeTruthy();
    expect(within(screen.getByTestId("mcp-bundled")).getByText("slack")).toBeTruthy();
    expect(within(screen.getByTestId("mcp-bundled")).getByText("notion")).toBeTruthy();
    expect(within(screen.getByTestId("mcp-user")).getByText("C:/pi/mcp.json")).toBeTruthy();
    expect(within(screen.getByTestId("mcp-user")).getByText("fxhoudini")).toBeTruthy();

    for (const sectionId of ["skills-bundled", "skills-user", "mcp-bundled", "mcp-user"]) {
      expect(screen.getByTestId(sectionId).className.split(/\s+/)).toContain("bg-surface");
    }
    expect(within(screen.getByTestId("mcp-user")).getByText("custom")).toBeTruthy();
    expect(within(screen.getByTestId("mcp-bundled")).queryByText("fxhoudini")).toBeNull();

    for (const heading of ["スキル", "MCP サーバー"]) {
      const list = screen.getByRole("heading", { name: heading }).parentElement?.parentElement?.querySelector("ul");
      expect(list).not.toBeNull();
      expect(list?.className).not.toContain("max-h-");
      expect(list?.className).not.toContain("overflow-y-auto");
      expect(list?.className).toContain("sm:grid-cols-2");
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

  it("reflects a skill toggle before the API response", async () => {
    let resolveRequest!: (value: unknown) => void;
    const request = new Promise((resolve) => {
      resolveRequest = resolve;
    });
    sendJson.mockReturnValueOnce(request);

    render(<SkillsSettings />);
    fireEvent.click(await screen.findByRole("switch", { name: "review（Code）を無効化" }));

    const toggle = screen.getByRole("switch", { name: "review（Code）を有効化" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    resolveRequest({
      skills: [{ id: "review", name: "review", enabled: false, codeEnabled: false, botEnabled: false, source: "pi" }],
    });
    await waitFor(() => expect(screen.getByRole("switch", { name: "review（Code）を有効化" })).toBeTruthy());
  });

  it("n8nとSlackの公式スキルをそれぞれ一つのトグルにまとめる", async () => {
    getJson.mockImplementation((path: string) => {
      if (path === "/api/skills") {
        return Promise.resolve({
          skills: [
            { id: "n8n-agents-official", name: "n8n-agents-official", enabled: true, codeEnabled: true, botEnabled: true, source: "bundled" },
            { id: "using-n8n-skills-official", name: "using-n8n-skills-official", enabled: true, codeEnabled: true, botEnabled: true, source: "bundled" },
            { id: "slack-api", name: "slack-api", enabled: true, codeEnabled: true, botEnabled: true, source: "bundled" },
            { id: "slack-cli", name: "slack-cli", enabled: true, codeEnabled: true, botEnabled: true, source: "bundled" },
          ],
          skillsDir: "C:/pi/skills",
        });
      }
      return Promise.reject(new Error(`unexpected path: ${path}`));
    });
    sendJson.mockResolvedValue({
      skills: [
        { id: "n8n-agents-official", name: "n8n-agents-official", enabled: true, codeEnabled: true, botEnabled: true, source: "bundled" },
        { id: "using-n8n-skills-official", name: "using-n8n-skills-official", enabled: true, codeEnabled: true, botEnabled: true, source: "bundled" },
        { id: "slack-api", name: "slack-api", enabled: false, codeEnabled: true, botEnabled: false, source: "bundled" },
        { id: "slack-cli", name: "slack-cli", enabled: false, codeEnabled: true, botEnabled: false, source: "bundled" },
      ],
    });

    render(<SkillsSettings scope="bot" />);

    await screen.findByRole("switch", { name: "n8n（Bot）を無効化" });
    expect(screen.getByRole("switch", { name: "Slack（Bot）を無効化" })).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "slack-api（Bot）を無効化" })).toBeNull();

    fireEvent.click(screen.getByRole("switch", { name: "Slack（Bot）を無効化" }));
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith(
      "/api/skills",
      { names: ["slack-api", "slack-cli"], enabled: false, scope: "bot" },
      "POST",
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
