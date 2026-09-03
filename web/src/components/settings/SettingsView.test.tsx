// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

  it("モデルタブをモデル、Autoモデル、生成モデル、プロバイダーの順に表示する", () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("button", { name: /^モデルタブ$/ }));

    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
      "モデル",
      "Autoモデル",
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
    fireEvent.click(screen.getByRole("button", { name: /^モデルタブ$/ }));

    await waitFor(() => {
      expect(screen.getByTestId("provider-count").textContent).toBe("1");
    });
  });

  it("エンジンタブをセクションごとに切り替え、選択したセクションをハッシュに反映する", () => {
    render(<SettingsView />);

    expect(screen.getByRole("navigation", { name: "エンジン設定" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "基本" }));

    expect(screen.getByRole("heading", { name: "基本" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "ブラウザ設定" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "思考要約の翻訳" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "応答" }));

    expect(window.location.hash).toBe("#engine-response");
    expect(screen.getByRole("heading", { name: "応答" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "思考要約の翻訳" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "ブラウザ設定" })).toBeNull();
  });

  it("エンジン設定では選択中セクションだけをマウントする", () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("button", { name: "基本" }));

    expect(mountCounts.basic).toBe(1);
    expect(mountCounts.response).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "応答" }));

    expect(mountCounts.basic).toBe(1);
    expect(mountCounts.response).toBe(1);
  });

  it("エンジンセクションのハッシュから直接開ける", () => {
    window.history.replaceState(null, "", "/settings#engine-basic");
    render(<SettingsView />);

    expect(within(screen.getByRole("navigation", { name: "設定" })).getByRole("button", { name: "エンジンタブ" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("heading", { name: "基本" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "ブラウザ設定" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "思考要約の翻訳" })).toBeNull();
  });

  it("エージェントタブがトップレベルに昇格し、AGENTS.md・メモリを直接表示する", () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("button", { name: /^エージェントタブ$/ }));

    expect(screen.getByRole("heading", { name: "AGENTS.md" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "メモリ" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "スキル" })).toBeTruthy();
  });

  it("拡張タブがトップレベルに昇格し、拡張機能・MCPサーバーを直接表示する", () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("button", { name: /^拡張タブ$/ }));

    expect(screen.getByRole("heading", { name: "拡張機能" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "MCPサーバー" })).toBeTruthy();
  });

  it("旧 #general-basic / #general-response ハッシュからエンジンタブにリダイレクトし、ハッシュを新形式に正規化する", () => {
    window.history.replaceState(null, "", "/settings#general-response");
    render(<SettingsView />);

    expect(within(screen.getByRole("navigation", { name: "設定" })).getByRole("button", { name: "エンジンタブ" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("heading", { name: "応答" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "思考要約の翻訳" })).toBeTruthy();
    expect(window.location.hash).toBe("#engine-response");
  });

  it("旧 #general-agents ハッシュからエージェントタブにリダイレクトする", () => {
    window.history.replaceState(null, "", "/settings#general-agents");
    render(<SettingsView />);

    expect(within(screen.getByRole("navigation", { name: "設定" })).getByRole("button", { name: "エージェントタブ" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("heading", { name: "AGENTS.md" })).toBeTruthy();
    expect(window.location.hash).toBe("");
  });

  it("旧 #general-integrations ハッシュから拡張タブにリダイレクトする", () => {
    window.history.replaceState(null, "", "/settings#general-integrations");
    render(<SettingsView />);

    expect(within(screen.getByRole("navigation", { name: "設定" })).getByRole("button", { name: "拡張タブ" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("heading", { name: "拡張機能" })).toBeTruthy();
    expect(window.location.hash).toBe("");
  });

  it("エンジン以外のハッシュ変更では engineSection をリセットしない", () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("button", { name: "応答" }));
    expect(screen.getByRole("heading", { name: "思考要約の翻訳" })).toBeTruthy();

    window.history.replaceState(null, "", "/settings#unrelated");
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    expect(screen.getByRole("heading", { name: "応答" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "思考要約の翻訳" })).toBeTruthy();
  });
});
