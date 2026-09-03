// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsView } from "./SettingsView";

const { getJson, mountCounts } = vi.hoisted(() => ({
  getJson: vi.fn(),
  mountCounts: { basic: 0, response: 0, memory: 0 },
}));

vi.mock("@/lib/client", () => ({ getJson }));
vi.mock("@/components/shell/MobileMenuHeader", () => ({ MobileMenuHeader: () => null }));
vi.mock("@/components/settings/HostRestartPanel", () => ({ HostRestartPanel: () => null }));
vi.mock("@/components/settings/LlamaServerSettings", () => ({
  LlamaServerSettings: () => <h2>ローカル LLM</h2>,
}));
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
  MemorySettings: () => {
    useEffect(() => {
      mountCounts.memory += 1;
    }, []);
    return (
      <>
        <h2>メモリ</h2>
        <input aria-label="メモリ設定の下書き" defaultValue="" />
      </>
    );
  },
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
    mountCounts.memory = 0;
    getJson.mockResolvedValue({ providers: [] });
  });

  afterEach(() => {
    cleanup();
    getJson.mockReset();
  });

  it("モデルタブをモデル、ローカルLLM、Autoモデル、生成モデル、プロバイダーの順に表示する", () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("tab", { name: /^モデルタブ$/ }));

    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
      "モデル",
      "ローカル LLM",
      "Autoモデル",
      "生成モデル",
      "プロバイダー",
    ]);
    expect(within(screen.getByRole("navigation", { name: "モデル設定内" })).getAllByRole("link")).toHaveLength(5);
  });

  it("ヘルス取得が遅くてもプロバイダー一覧を先に反映する", async () => {
    const health = new Promise<never>(() => {});
    getJson.mockImplementation((path: string) =>
      path === "/api/health"
        ? health
        : Promise.resolve({ providers: [{ id: "anthropic" }] }),
    );

    render(<SettingsView />);
    fireEvent.click(screen.getByRole("tab", { name: /^モデルタブ$/ }));

    await waitFor(() => {
      expect(screen.getByTestId("provider-count").textContent).toBe("1");
    });
  });

  it("ヘルス取得中は確認中と表示し、未接続と誤表示しない", async () => {
    let resolveHealth!: (value: { engineOk: boolean }) => void;
    getJson.mockImplementation((path: string) =>
      path === "/api/health"
        ? new Promise((resolve) => { resolveHealth = resolve; })
        : Promise.resolve({ providers: [] }),
    );

    render(<SettingsView />);

    expect(screen.getByText("確認中")).toBeTruthy();
    expect(screen.queryByText("未接続")).toBeNull();

    resolveHealth({ engineOk: true });

    await waitFor(() => {
      expect(screen.getByText("利用可")).toBeTruthy();
    });
  });

  it("エンジンタブ内にサブタブを置かず、基本・応答設定をすべて表示する", () => {
    render(<SettingsView />);

    expect(screen.queryByRole("navigation", { name: "エンジン設定" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "ローカル LLM" })).toBeNull();
    expect(screen.getByRole("heading", { name: "ブラウザ設定" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "思考要約の翻訳" })).toBeTruthy();
    expect(mountCounts.basic).toBe(1);
    expect(mountCounts.response).toBe(1);
  });

  it("廃止したエンジンサブタブのハッシュからエンジンタブを開き、正規ハッシュへ置き換える", () => {
    window.history.replaceState(null, "", "/settings#engine-basic");
    render(<SettingsView />);

    expect(within(screen.getByRole("tablist", { name: "設定" })).getByRole("tab", { name: "エンジンタブ" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("heading", { name: "ブラウザ設定" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "思考要約の翻訳" })).toBeTruthy();
    expect(window.location.hash).toBe("#engine");
  });

  it("エージェントタブにAGENTS.mdとエージェントだけを表示する", () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("tab", { name: /^エージェントタブ$/ }));

    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
      "エージェント",
      "AGENTS.md",
    ]);
    expect(screen.queryByRole("heading", { name: "メモリ" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "スキル" })).toBeNull();
  });

  it("拡張タブに拡張機能・メモリ・スキル・MCPサーバーを表示する", () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("tab", { name: /^拡張タブ$/ }));

    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
      "拡張機能",
      "スキル",
      "MCPサーバー",
      "メモリ",
    ]);
    expect(within(screen.getByRole("navigation", { name: "拡張設定内" })).getAllByRole("link")).toHaveLength(4);
  });

  it("旧 #general-basic / #general-response ハッシュからエンジンタブにリダイレクトする", () => {
    window.history.replaceState(null, "", "/settings#general-response");
    render(<SettingsView />);

    expect(within(screen.getByRole("tablist", { name: "設定" })).getByRole("tab", { name: "エンジンタブ" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("heading", { name: "ブラウザ設定" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "思考要約の翻訳" })).toBeTruthy();
    expect(window.location.hash).toBe("#engine");
  });

  it("旧 #general-agents ハッシュからエージェントタブにリダイレクトする", () => {
    window.history.replaceState(null, "", "/settings#general-agents");
    render(<SettingsView />);

    expect(within(screen.getByRole("tablist", { name: "設定" })).getByRole("tab", { name: "エージェントタブ" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("heading", { name: "AGENTS.md" })).toBeTruthy();
    expect(window.location.hash).toBe("#agents");
  });

  it("旧 #general-integrations ハッシュから拡張タブにリダイレクトする", () => {
    window.history.replaceState(null, "", "/settings#general-integrations");
    render(<SettingsView />);

    expect(within(screen.getByRole("tablist", { name: "設定" })).getByRole("tab", { name: "拡張タブ" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("heading", { name: "拡張機能" })).toBeTruthy();
    expect(window.location.hash).toBe("#extensions");
  });

  it("セクションのハッシュから対応するタブを開く", () => {
    window.history.replaceState(null, "", "/settings#extensions-skills");
    render(<SettingsView />);

    expect(screen.getByRole("tab", { name: "拡張タブ" }).getAttribute("aria-selected")).toBe("true");
    expect(document.getElementById("extensions-skills")).not.toBeNull();
  });

  it("設定以外のハッシュ変更では選択タブを変更しない", () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("tab", { name: "エージェントタブ" }));

    window.history.replaceState(null, "", "/settings#unrelated");
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    expect(within(screen.getByRole("tablist", { name: "設定" })).getByRole("tab", { name: "エージェントタブ" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("heading", { name: "AGENTS.md" })).toBeTruthy();
  });

  it("矢印キーでタブを移動し、正規ハッシュとパネルの関連を更新する", () => {
    render(<SettingsView />);
    const engineTab = screen.getByRole("tab", { name: "エンジンタブ" });

    fireEvent.keyDown(engineTab, { key: "ArrowRight" });

    const modelsTab = screen.getByRole("tab", { name: "モデルタブ" });
    expect(modelsTab.getAttribute("aria-selected")).toBe("true");
    expect(modelsTab.getAttribute("aria-controls")).toBe("settings-panel-models");
    expect(document.activeElement).toBe(modelsTab);
    expect(window.location.hash).toBe("#models");
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe("settings-tab-models");
  });

  it("一度開いたタブを非表示で保持し、切替後も下書きを残す", () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("tab", { name: "拡張タブ" }));
    const draft = screen.getByLabelText("メモリ設定の下書き") as HTMLInputElement;
    fireEvent.change(draft, { target: { value: "未保存の設定" } });

    fireEvent.click(screen.getByRole("tab", { name: "エンジンタブ" }));
    expect(draft.closest('[role="tabpanel"]')?.hasAttribute("hidden")).toBe(true);

    fireEvent.click(screen.getByRole("tab", { name: "拡張タブ" }));
    expect(screen.getByLabelText("メモリ設定の下書き")).toBe(draft);
    expect(draft.value).toBe("未保存の設定");
    expect(mountCounts.memory).toBe(1);
  });
});
