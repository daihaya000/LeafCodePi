// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsView } from "./SettingsView";

const { getJson, mountCounts } = vi.hoisted(() => ({
  getJson: vi.fn(),
  mountCounts: { basic: 0, response: 0 },
}));

vi.mock("@/lib/client", () => ({ getJson }));
vi.mock("@/components/shell/MobileMenuHeader", () => ({ MobileMenuHeader: () => null }));
vi.mock("@/components/settings/HostRestartPanel", () => ({ HostRestartPanel: () => null }));
vi.mock("@/components/settings/LlamaServerSettings", () => ({ LlamaServerSettings: () => null }));
vi.mock("@/components/settings/ProviderModelsPanel", () => ({
  ProviderModelsPanel: () => <h2>モデル</h2>,
}));
vi.mock("@/components/settings/ProviderAuthPanel", () => ({
  ProviderAuthPanel: ({ providers }: { providers: unknown[] }) => (
    <>
      <h2>プロバイダー</h2>
      <span data-testid="provider-count">{providers.length}</span>
    </>
  ),
}));
vi.mock("@/components/settings/GenerationModelSettings", () => ({
  GenerationModelSettings: () => <h2>生成モデル</h2>,
}));
vi.mock("@/components/settings/BrowserSettings", () => ({
  BrowserSettings: () => {
    mountCounts.basic += 1;
    return <h2>ブラウザ設定</h2>;
  },
}));
vi.mock("@/components/settings/NotificationSoundSettings", () => ({
  NotificationSoundSettings: () => <h2>通知音</h2>,
}));
vi.mock("@/components/settings/NavigatorSettings", () => ({
  NavigatorSettings: () => <h2>ナビゲーター</h2>,
}));
vi.mock("@/components/settings/ReasoningTranslationSettings", () => ({
  ReasoningTranslationSettings: () => {
    mountCounts.response += 1;
    return <h2>思考要約の翻訳</h2>;
  },
}));
vi.mock("@/components/settings/CompactionSettings", () => ({
  CompactionSettings: () => <h2>コンテキスト圧縮</h2>,
}));
vi.mock("@/components/settings/HangTimeoutSettings", () => ({
  HangTimeoutSettings: () => <h2>ハング判定</h2>,
}));
vi.mock("@/components/settings/AgentsMdSettings", () => ({
  AgentsMdSettings: () => <h2>AGENTS.md</h2>,
}));
vi.mock("@/components/settings/MemorySettings", () => ({
  MemorySettings: () => <h2>メモリ</h2>,
}));
vi.mock("@/components/settings/SkillsSettings", () => ({
  SkillsSettings: () => <h2>スキル</h2>,
}));
vi.mock("@/components/settings/AgentsSettings", () => ({
  AgentsSettings: () => <h2>エージェント</h2>,
}));
vi.mock("@/components/settings/ExtensionsSettings", () => ({
  ExtensionsSettings: () => <h2>拡張機能</h2>,
}));
vi.mock("@/components/settings/McpSettings", () => ({
  McpSettings: () => <h2>MCPサーバー</h2>,
}));

describe("SettingsView", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/settings");
    mountCounts.basic = 0;
    mountCounts.response = 0;
    getJson.mockResolvedValue({ providers: [] });
  });

  afterEach(() => {
    cleanup();
    getJson.mockReset();
  });

  it("モデルタブをモデル、Auto、生成モデル、プロバイダーの順に表示する", () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("button", { name: /^モデル$/ }));

    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
      "モデル",
      "Auto モード",
      "生成モデル",
      "プロバイダー",
    ]);
  });

  it("ヘルス取得が遅くてもプロバイダー一覧を先に反映する", async () => {
    const health = new Promise<never>(() => {});
    getJson.mockImplementation((path: string) =>
      path === "/api/health"
        ? health
        : Promise.resolve({ providers: [{ id: "anthropic" }] }),
    );

    render(<SettingsView />);
    fireEvent.click(screen.getByRole("button", { name: /^モデル$/ }));

    await waitFor(() => {
      expect(screen.getByTestId("provider-count").textContent).toBe("1");
    });
  });

  it("一般タブをカテゴリごとに切り替え、選択したカテゴリをハッシュに反映する", () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("button", { name: /^一般$/ }));

    expect(screen.getByRole("navigation", { name: "一般設定" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "基本" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "ブラウザ設定" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "思考要約の翻訳" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "応答" }));

    expect(window.location.hash).toBe("#general-response");
    expect(screen.getByRole("heading", { name: "応答" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "思考要約の翻訳" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "ブラウザ設定" })).toBeNull();
  });

  it("一般設定では選択中カテゴリだけをマウントする", () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("button", { name: /^一般$/ }));

    expect(mountCounts.basic).toBe(1);
    expect(mountCounts.response).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "応答" }));

    expect(mountCounts.basic).toBe(1);
    expect(mountCounts.response).toBe(1);
  });

  it("一般カテゴリのハッシュから直接開ける", () => {
    window.history.replaceState(null, "", "/settings#general-agents");
    render(<SettingsView />);

    expect(screen.getByRole("button", { name: "一般" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("heading", { name: "エージェント環境" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "AGENTS.md" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "メモリ" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "ブラウザ設定" })).toBeNull();
  });
});
