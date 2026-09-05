// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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
  LlamaServerSettings: () => <h3>ローカル LLM</h3>,
}));
vi.mock("@/components/settings/ProviderModelsPanel", () => ({
  ProviderModelsPanel: () => <h3>モデル</h3>,
}));
vi.mock("@/components/settings/ProviderAuthPanel", () => ({
  ProviderAuthPanel: ({ providers }: { providers: unknown[] }) => (
    <>
      <h3>プロバイダー</h3>
      <span data-testid="provider-count">{providers.length}</span>
    </>
  ),
}));
vi.mock("@/components/settings/GenerationModelSettings", () => ({
  GenerationModelSettings: () => <h3>生成モデル</h3>,
}));
vi.mock("@/components/settings/BrowserSettings", () => ({
  BrowserSettings: () => {
    mountCounts.basic += 1;
    return <h3>ブラウザ設定</h3>;
  },
}));
vi.mock("@/components/settings/SystemSafetySettings", () => ({
  SystemSafetySettings: () => <h3>システム安全ガード</h3>,
}));
vi.mock("@/components/settings/CommitGuardSettings", () => ({
  CommitGuardSettings: () => <h3>コミットガード</h3>,
}));
vi.mock("@/components/settings/NotificationSoundSettings", () => ({
  NotificationSoundSettings: () => <h3>通知音</h3>,
}));
vi.mock("@/components/settings/NavigatorSettings", () => ({
  NavigatorSettings: () => <h3>ナビゲーター</h3>,
}));
vi.mock("@/components/settings/ReasoningTranslationSettings", () => ({
  ReasoningTranslationSettings: () => {
    mountCounts.response += 1;
    return <h3>思考要約の翻訳</h3>;
  },
}));
vi.mock("@/components/settings/CompactionSettings", () => ({
  CompactionSettings: () => <h3>コンテキスト圧縮</h3>,
}));
vi.mock("@/components/settings/HangTimeoutSettings", () => ({
  HangTimeoutSettings: () => <h3>ハング判定</h3>,
}));
vi.mock("@/components/settings/AgentsMdSettings", () => ({
  AgentsMdSettings: () => <h3>AGENTS.md</h3>,
}));
vi.mock("@/components/settings/MemorySettings", () => ({
  MemorySettings: () => {
    useEffect(() => {
      mountCounts.memory += 1;
    }, []);
    return (
      <>
        <h3>メモリ</h3>
        <input aria-label="メモリ設定の下書き" defaultValue="" />
      </>
    );
  },
}));
vi.mock("@/components/settings/SkillsSettings", () => ({
  SkillsSettings: () => <h3>スキル</h3>,
}));
vi.mock("@/components/settings/AgentsSettings", () => ({
  AgentsSettings: () => <h3>エージェント</h3>,
}));
vi.mock("@/components/settings/ExtensionsSettings", () => ({
  ExtensionsSettings: () => <h3>拡張機能</h3>,
}));
vi.mock("@/components/settings/McpSettings", () => ({
  McpSettings: () => <h3>MCPサーバー</h3>,
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

  it("モデルタブを役割ごとのグループに分けて表示する", () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("tab", { name: /^モデルタブ$/ }));

    const modelsPanel = screen.getByRole("tabpanel");
    expect(
      Array.from(modelsPanel.querySelectorAll("section[aria-labelledby] > header > h2")).map(
        (heading) => heading.textContent,
      ),
    ).toEqual(["モデルカタログ", "自動選択と生成", "プロバイダー接続"]);
    expect(Array.from(modelsPanel.querySelectorAll("h3")).map((heading) => heading.textContent)).toEqual([
      "モデル",
      "Autoモデル",
      "生成モデル",
      "プロバイダー",
    ]);
    expect(screen.queryByRole("navigation", { name: "モデル設定内" })).toBeNull();
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

  it("ヘルス取得に失敗した場合は未接続と表示し、次回成功でエラーが消える", async () => {
    getJson.mockImplementation((path: string) =>
      path === "/api/health"
        ? Promise.reject(new Error("network error"))
        : Promise.resolve({ providers: [] }),
    );

    const view = render(<SettingsView />);

    await waitFor(() => {
      expect(screen.getByText("未接続")).toBeTruthy();
    });
    expect(screen.getByText("ヘルスの取得に失敗しました")).toBeTruthy();

    // コンポーネント内部の reload は HostRestartPanel の onRestarted 経由でしか呼べず、
    // そのパネルはモックでnullを返すため、再マウントの mount エフェクトで代替検証する。
    view.unmount();
    getJson.mockImplementation((path: string) =>
      path === "/api/health"
        ? Promise.resolve({ engineOk: true })
        : Promise.resolve({ providers: [] }),
    );
    render(<SettingsView />);

    await waitFor(() => {
      expect(screen.getByText("利用可")).toBeTruthy();
    });
    expect(screen.queryByText("ヘルスの取得に失敗しました")).toBeNull();
  });

  it("ハッシュに関わらずサーバー相当レンダーは常にエンジンタブになり、hydration不一致を防ぐ", () => {
    window.history.replaceState(null, "", "/settings#models");
    getJson.mockImplementation(() => new Promise(() => {}));

    const html = renderToStaticMarkup(<SettingsView />);

    expect(html).toContain('id="settings-tab-engine" type="button" role="tab" aria-label="エンジンタブ" aria-selected="true"');
    expect(html).toContain('id="settings-tab-models" type="button" role="tab" aria-label="モデルタブ" aria-selected="false"');
  });

  it("エンジンタブを役割ごとのグループに分け、関連設定をまとめて表示する", () => {
    render(<SettingsView />);

    const enginePanel = screen.getByRole("tabpanel");
    expect(
      Array.from(enginePanel.querySelectorAll("section[aria-labelledby] > header > h2")).map(
        (heading) => heading.textContent,
      ),
    ).toEqual(["ランタイム", "アクセスと安全", "応答", "表示と通知", "ローカル推論", "メモリ"]);
    expect(screen.getByRole("heading", { name: "システム安全ガード" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "ローカル LLM" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "メモリ", level: 2 })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "コミットガード" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "ブラウザ設定" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "思考要約の翻訳" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Pi Coding Agent" }).tagName).toBe("H3");
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

  it("エージェントタブを運用と共通指示のグループに分ける", () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("tab", { name: /^エージェントタブ$/ }));

    const agentsPanel = screen.getByRole("tabpanel");
    expect(
      Array.from(agentsPanel.querySelectorAll("section[aria-labelledby] > header > h2")).map(
        (heading) => heading.textContent,
      ),
    ).toEqual(["エージェント運用", "共通指示"]);
    expect(Array.from(agentsPanel.querySelectorAll("h3")).map((heading) => heading.textContent)).toEqual([
      "エージェント",
      "AGENTS.md",
    ]);
    expect(screen.queryByRole("heading", { name: "メモリ" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "スキル" })).toBeNull();
  });

  it("拡張タブを管理、連携のグループに分ける", () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("tab", { name: /^拡張タブ$/ }));

    const extensionsPanel = screen.getByRole("tabpanel");
    expect(
      Array.from(extensionsPanel.querySelectorAll("section[aria-labelledby] > header > h2")).map(
        (heading) => heading.textContent,
      ),
    ).toEqual(["拡張機能の管理", "スキルと連携"]);
    expect(Array.from(extensionsPanel.querySelectorAll("h3")).map((heading) => heading.textContent)).toEqual([
      "拡張機能",
      "スキル",
      "MCPサーバー",
    ]);
    expect(screen.queryByRole("heading", { name: "メモリ" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "拡張設定内" })).toBeNull();
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

  it("移動したローカル推論のハッシュからエンジンタブを開く", () => {
    window.history.replaceState(null, "", "/settings#models-local");
    render(<SettingsView />);

    expect(screen.getByRole("tab", { name: "エンジンタブ" }).getAttribute("aria-selected")).toBe("true");
    expect(document.getElementById("models-local")).not.toBeNull();
  });

  it("移動したメモリのハッシュからエンジンタブを開く", () => {
    window.history.replaceState(null, "", "/settings#extensions-memory");
    render(<SettingsView />);

    expect(screen.getByRole("tab", { name: "エンジンタブ" }).getAttribute("aria-selected")).toBe("true");
    expect(document.getElementById("extensions-memory")?.closest('[role="tabpanel"]')?.id).toBe("settings-panel-engine");
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
    const draft = screen.getByLabelText("メモリ設定の下書き") as HTMLInputElement;
    fireEvent.change(draft, { target: { value: "未保存の設定" } });

    fireEvent.click(screen.getByRole("tab", { name: "モデルタブ" }));
    expect(draft.closest('[role="tabpanel"]')?.hasAttribute("hidden")).toBe(true);

    fireEvent.click(screen.getByRole("tab", { name: "エンジンタブ" }));
    expect(screen.getByLabelText("メモリ設定の下書き")).toBe(draft);
    expect(draft.value).toBe("未保存の設定");
    expect(mountCounts.memory).toBe(1);
  });
});
