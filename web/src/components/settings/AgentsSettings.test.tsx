// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toolNameLabel } from "@/lib/tool-labels";
import { AGENT_TOOL_NAMES } from "@/lib/agent-tool-catalog";
import { type ModelOption } from "@/lib/types";
import { AgentsSettings } from "./AgentsSettings";

const { getJson, sendJson } = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
}));

vi.mock("@/lib/client", () => ({ getJson, sendJson }));
vi.mock("@/components/ModelSelect", () => ({
  ModelSelect: ({
    value,
    options,
    disabled,
    onChange,
    ariaLabel,
    className,
  }: {
    value: string;
    options: ModelOption[];
    disabled?: boolean;
    onChange: (value: string) => void;
    ariaLabel?: string;
    className?: string;
  }) => (
    <select
      aria-label={ariaLabel}
      className={className}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

const agents = [
  {
    id: "disabled",
    name: "disabled",
    enabled: false,
    source: "package" as const,
    filePath: "C:/disabled.md",
  },
  {
    id: "enabled",
    name: "enabled",
    enabled: true,
    tools: ["read"],
    model: "openai-codex/gpt-5.6-luna",
    systemPrompt: "実装を確認する。",
    source: "package" as const,
    filePath: "C:/enabled.md",
  },
];

const models: ModelOption[] = [
  {
    value: "openai-codex::gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    providerID: "openai-codex",
    modelID: "gpt-5.6-luna",
    thinkingLevels: ["low", "medium", "high"],
  },
  {
    value: "anthropic::claude",
    label: "Claude",
    providerID: "anthropic",
    modelID: "claude",
    thinkingLevels: [],
  },
];

describe("AgentsSettings", () => {
  beforeEach(() => {
    getJson.mockImplementation((path: string) =>
      path === "/api/agents"
        ? Promise.resolve({ agents, agentsDir: "C:/pi/agent/agents", autoEnabled: false })
        : path === "/api/settings/auto-agent-prompt"
          ? Promise.resolve({
              value: null,
              defaultPrompt: "既定の選定プロンプト\n{\"agent\":\"候補名\"}",
            })
          : Promise.resolve({ models }),
    );
    sendJson.mockResolvedValue({ agents });
  });

  afterEach(() => {
    cleanup();
    getJson.mockReset();
    sendJson.mockReset();
  });

  it("デフォルト無効のAutoエージェントを有効化できる", async () => {
    render(<AgentsSettings />);

    const toggle = await screen.findByRole("switch", { name: "Autoエージェントを有効化" });
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(sendJson).toHaveBeenCalledWith(
        "/api/settings/auto-agent-enabled",
        { value: "1" },
        "PUT",
      );
    });
  });

  it("keeps the default agent enabled while other agents can still be toggled", async () => {
    const defaultAgent = {
      id: "default", name: "default", enabled: true,
      source: "package" as const, filePath: "C:/default.md",
    };
    getJson.mockImplementation((path: string) =>
      path === "/api/agents"
        ? Promise.resolve({ agents: [defaultAgent, ...agents], autoEnabled: false })
        : Promise.resolve({ models }),
    );
    render(<AgentsSettings />);

    const locked = await screen.findByRole("switch", { name: "default は常に有効" }) as HTMLButtonElement;
    expect(locked.disabled).toBe(true);
    expect(locked.getAttribute("aria-checked")).toBe("true");
    expect(locked.title).toContain("無効化できません");
    fireEvent.click(locked);
    expect(sendJson).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("switch", { name: "enabled を無効化" }));
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith(
      "/api/agents/enabled", { enabled: false }, "PATCH",
    ));
  });

  it("can restore a legacy disabled default agent", async () => {
    const defaultAgent = {
      id: "default", name: "default", enabled: false,
      source: "package" as const, filePath: "C:/default.md",
    };
    getJson.mockImplementation((path: string) =>
      path === "/api/agents"
        ? Promise.resolve({ agents: [defaultAgent, ...agents], autoEnabled: false })
        : Promise.resolve({ models }),
    );
    sendJson.mockResolvedValueOnce({ agents: [{ ...defaultAgent, enabled: true }, ...agents] });
    render(<AgentsSettings />);

    const restore = await screen.findByRole("switch", { name: "default を有効化" }) as HTMLButtonElement;
    expect(restore.disabled).toBe(false);
    fireEvent.click(restore);
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith(
      "/api/agents/default", { enabled: true }, "PATCH",
    ));
    expect((await screen.findByRole("switch", { name: "default は常に有効" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("prioritizes enabled agents and saves a selected model", async () => {
    render(<AgentsSettings />);

    await screen.findByRole("switch", { name: "enabled を無効化" });
    expect(screen.getByText("enabled").parentElement?.querySelector('[data-agent-icon="enabled"]')).not.toBeNull();
    expect(screen.getByText("disabled").parentElement?.querySelector('[data-agent-icon="disabled"]')).not.toBeNull();
    expect(screen.getAllByRole("listitem").map((item) => item.querySelector("p")?.textContent)).toEqual([
      "enabled",
      "disabled",
    ]);

    const model = screen.getByRole("combobox", { name: "enabled のモデル" }) as HTMLSelectElement;
    expect(model.className).toContain("w-full");
    expect(model.value).toBe("openai-codex::gpt-5.6-luna");
    fireEvent.change(model, { target: { value: "anthropic::claude" } });

    await waitFor(() => {
      expect(sendJson).toHaveBeenCalledWith(
        "/api/agents/enabled",
        { model: "anthropic/claude" },
        "PATCH",
      );
    });
  });

  it("各エージェントを初期状態で折り畳み、個別に展開できる", async () => {
    render(<AgentsSettings />);

    const enabledRow = (await screen.findByRole("switch", { name: "enabled を無効化" })).closest("li")!;
    const disabledRow = screen.getByRole("switch", { name: "disabled を有効化" }).closest("li")!;
    const enabledDetails = enabledRow.querySelector<HTMLDetailsElement>("details[aria-label='enabledの設定']")!;
    const disabledDetails = disabledRow.querySelector<HTMLDetailsElement>("details[aria-label='disabledの設定']")!;
    expect(enabledDetails.open).toBe(false);
    expect(disabledDetails.open).toBe(false);
    expect(enabledDetails.querySelector("summary")?.textContent).toContain("有効");

    fireEvent.click(within(enabledDetails).getByText("enabled"));
    expect(enabledDetails.open).toBe(true);
    expect(disabledDetails.open).toBe(false);
    expect(within(enabledDetails).getByRole("combobox", { name: "enabled のモデル" })).toBeTruthy();

    fireEvent.click(within(enabledRow).getByRole("switch", { name: "enabled を無効化" }));
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith(
      "/api/agents/enabled", { enabled: false }, "PATCH",
    ));
    expect(enabledDetails.open).toBe(true);
    expect(disabledDetails.open).toBe(false);

    fireEvent.click(within(enabledDetails).getByText("enabled"));
    expect(enabledDetails.open).toBe(false);
  });

  it("各エージェントのシステムプロンプトを展開して確認できる", async () => {
    render(<AgentsSettings />);

    const row = (await screen.findByRole("switch", { name: "enabled を無効化" })).closest("li");
    expect(row).not.toBeNull();
    const details = row!.querySelector<HTMLDetailsElement>("details[aria-label='enabledのシステムプロンプト']");
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);

    fireEvent.click(within(details!).getByText("システムプロンプト"));

    expect(details!.open).toBe(true);
    expect(within(details!).getByText("実装を確認する。")).toBeTruthy();
  });

  it("折り畳んだツール設定を必要時に展開できる", async () => {
    render(<AgentsSettings />);

    const row = (await screen.findByRole("switch", { name: "enabled を無効化" })).closest("li");
    expect(row).not.toBeNull();
    const details = row!.querySelector<HTMLDetailsElement>("details[aria-label='enabledのツール設定']");
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);

    fireEvent.click(within(details!).getByText("使用するツール"));

    expect(details!.open).toBe(true);
    expect(within(details!).getByRole("checkbox", { name: `enabled の${toolNameLabel("read")}` })).toBeTruthy();
  });

  it("edits a user agent's tool permissions with checkboxes", async () => {
    const userAgent = {
      ...agents[1],
      id: "custom",
      name: "custom",
      source: "user" as const,
      tools: ["read", "write"],
    };
    getJson.mockImplementation((path: string) =>
      path === "/api/agents"
        ? Promise.resolve({ agents: [userAgent], agentsDir: "C:/pi/agent/agents" })
        : path === "/api/settings/auto-agent-prompt"
          ? Promise.resolve({ value: null })
          : Promise.resolve({ models }),
    );
    sendJson.mockResolvedValue({ agents: [{ ...userAgent, tools: ["read"] }] });

    render(<AgentsSettings />);

    const write = await screen.findByRole("checkbox", { name: `custom の${toolNameLabel("write")}` }) as HTMLInputElement;
    expect(write.checked).toBe(true);
    expect(write.closest("label")?.querySelector('[data-tool-access="write"] svg')).not.toBeNull();
    expect(screen.getByRole("checkbox", { name: `custom の${toolNameLabel("read")}` }).closest("label")?.querySelector('[data-tool-access="read"] svg')).not.toBeNull();
    fireEvent.click(write);

    await waitFor(() => {
      expect(sendJson).toHaveBeenCalledWith(
        "/api/agents/custom",
        { tools: ["read"] },
        "PATCH",
      );
    });
  });

  it("shows the complete tool catalog in two columns and lets package agents enable writing", async () => {
    const packageAgent = { ...agents[1], tools: ["read"] };
    getJson.mockImplementation((path: string) =>
      path === "/api/agents"
        ? Promise.resolve({ agents: [packageAgent], agentsDir: "C:/pi/agent/agents" })
        : path === "/api/settings/auto-agent-prompt"
          ? Promise.resolve({ value: null })
          : Promise.resolve({ models }),
    );
    sendJson.mockResolvedValue({ agents: [{ ...packageAgent, tools: ["read", "write"] }] });

    render(<AgentsSettings />);

    const write = await screen.findByRole("checkbox", { name: `enabled の${toolNameLabel("write")}` }) as HTMLInputElement;
    expect(write.checked).toBe(false);
    expect(write.disabled).toBe(false);
    expect(write.closest("label")?.querySelector('[data-tool-access="write"] svg')).not.toBeNull();
    expect(screen.getByRole("checkbox", { name: `enabled の${toolNameLabel("read")}` }).closest("label")?.querySelector('[data-tool-access="read"] svg')).not.toBeNull();
    const section = write.closest("section");
    expect(section).not.toBeNull();
    const groups = section!.querySelectorAll("[data-tool-group]");
    expect([...groups].map((group) => group.getAttribute("data-tool-group"))).toEqual(["write", "read"]);
    expect([...groups].every((group) => group.querySelector("div.grid")?.className.includes("grid-cols-2"))).toBe(true);
    expect([...groups].some((group) => group.querySelector("[data-tool-access=write]"))).toBe(true);
    expect([...groups].some((group) => group.querySelector("[data-tool-access=read]"))).toBe(true);
    fireEvent.click(write);

    await waitFor(() => {
      expect(sendJson).toHaveBeenCalledWith(
        "/api/agents/enabled",
        { tools: ["read", "write"] },
        "PATCH",
      );
    });

    const row = write.closest("li");
    expect(row).not.toBeNull();
    const agentTools = AGENT_TOOL_NAMES;
    expect(within(row!).getAllByRole("checkbox")).toHaveLength(agentTools.length);
    for (const tool of agentTools) {
      expect(within(row!).getByRole("checkbox", { name: `enabled の${toolNameLabel(tool)}` })).toBeTruthy();
    }
  });

  it("default tools are dynamically inherited without editable checkboxes, including legacy DTOs", async () => {
    const defaultAgent = { ...agents[1], id: "default", name: "default", tools: ["read"] };
    getJson.mockImplementation((path: string) => path === "/api/agents"
      ? Promise.resolve({ agents: [defaultAgent] }) : Promise.resolve({ models }));
    render(<AgentsSettings />);
    const row = (await screen.findByRole("switch", { name: "default は常に有効" })).closest("li")!;
    expect(within(row).getByText("全ツール継承・固定")).toBeTruthy();
    expect(within(row).getByText(/default は全登録ツールを動的に継承/)).toBeTruthy();
    expect(within(row).queryAllByRole("checkbox")).toHaveLength(0);
    expect(within(row).queryByRole("button", { name: /継承に戻す/ })).toBeNull();
    expect(sendJson).not.toHaveBeenCalled();
  });

  it("distinguishes inherited tools from deny-all and restores inheritance with null", async () => {
    const inheritedAgent = { ...agents[1], tools: undefined };
    getJson.mockImplementation((path: string) => path === "/api/agents"
      ? Promise.resolve({ agents: [inheritedAgent] }) : Promise.resolve({ models }));
    sendJson.mockResolvedValueOnce({ agents: [{ ...inheritedAgent, tools: [] }] });
    render(<AgentsSettings />);
    const row = (await screen.findByRole("switch", { name: "enabled を無効化" })).closest("li")!;
    expect(within(row).getByText("既定を継承")).toBeTruthy();
    expect(within(row).queryAllByRole("checkbox")).toHaveLength(0);
    fireEvent.click(within(row).getByRole("button", { name: "個別に制限（許可なしから選択）" }));
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith("/api/agents/enabled", { tools: [] }, "PATCH"));
    await waitFor(() => expect(within(row).getByText("許可なし")).toBeTruthy());
    expect(within(row).getAllByRole("checkbox").every((box) => !(box as HTMLInputElement).checked)).toBe(true);
    sendJson.mockResolvedValueOnce({ agents: [inheritedAgent] });
    fireEvent.click(within(row).getByRole("button", { name: "既定を継承に戻す" }));
    await waitFor(() => expect(sendJson).toHaveBeenLastCalledWith("/api/agents/enabled", { tools: null }, "PATCH"));
    await waitFor(() => expect(within(row).getByText("既定を継承")).toBeTruthy());
  });

  it("offers codemode without Bot-only entries and preserves unknown extension/MCP tools", async () => {
    const customAgent = { ...agents[1], tools: ["read", "future_tool"] };
    getJson.mockImplementation((path: string) => path === "/api/agents"
      ? Promise.resolve({ agents: [customAgent] }) : Promise.resolve({ models }));
    render(<AgentsSettings />);
    const codemode = await screen.findByRole("checkbox", { name: `enabled の${toolNameLabel("codemode")}` });
    expect(codemode.closest("[data-tool-group]")?.getAttribute("data-tool-group")).toBe("write");
    expect(screen.queryByRole("checkbox", { name: `enabled の${toolNameLabel("task_mutation_decision")}` })).toBeNull();
    expect((screen.getByRole("checkbox", { name: "enabled のfuture_tool" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "enabled の追加ツール名" }), { target: { value: "mcp__demo__read, future_tool" } });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith("/api/agents/enabled", { tools: ["read", "future_tool", "mcp__demo__read"] }, "PATCH"));
  });

  it("shows logical model candidates from separate accounts", async () => {
    const accountModels: ModelOption[] = [
      {
        ...models[0],
        value: "work::openai-codex::gpt-5.6-luna",
        accountId: "work",
        accountLabel: "仕事用",
      },
      {
        ...models[0],
        value: "personal::openai-codex::gpt-5.6-luna",
        accountId: "personal",
        accountLabel: "個人用",
      },
      {
        ...models[1],
        value: "work::anthropic::claude",
        accountId: "work",
        accountLabel: "仕事用",
      },
    ];
    getJson.mockImplementation((path: string) =>
      path === "/api/agents"
        ? Promise.resolve({ agents, agentsDir: "C:/pi/agent/agents" })
        : path === "/api/settings/auto-agent-prompt"
          ? Promise.resolve({ value: null })
          : Promise.resolve({ models: accountModels }),
    );

    render(<AgentsSettings />);

    const model = await screen.findByRole("combobox", { name: "enabled のモデル" }) as HTMLSelectElement;
    expect([...model.options].map((option) => [option.value, option.textContent])).toEqual([
      ["openai-codex::gpt-5.6-luna", "GPT-5.6 Luna"],
      ["anthropic::claude", "Claude"],
    ]);
  });

  it("saves subagent effort independently from the Composer setting", async () => {
    render(<AgentsSettings />);

    const effort = await screen.findByRole("button", { name: "enabled のEffort" });
    expect(effort.textContent).toContain("既定");
    fireEvent.click(effort);
    fireEvent.click(screen.getByRole("option", { name: "high" }));

    await waitFor(() => {
      expect(sendJson).toHaveBeenCalledWith(
        "/api/agents/enabled",
        { thinking: "high" },
        "PATCH",
      );
    });
  });

  it("offers only the effort levels the agent's model supports", async () => {
    render(<AgentsSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "enabled のEffort" }));

    const labels = within(screen.getByRole("listbox", { name: "enabled のEffort" }))
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(labels).toEqual(["既定", "無効", "low", "medium", "high"]);
  });

  it("offers no effort levels when the selected model reports an empty list", async () => {
    getJson.mockImplementation((path: string) =>
      path === "/api/agents"
        ? Promise.resolve({
            agents: [{ ...agents[1], model: "anthropic/claude" }],
            agentsDir: "C:/pi/agent/agents",
          })
        : path === "/api/settings/auto-agent-prompt"
          ? Promise.resolve({ value: null })
          : Promise.resolve({ models }),
    );
    render(<AgentsSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "enabled のEffort" }));

    const labels = within(screen.getByRole("listbox", { name: "enabled のEffort" }))
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(labels).toEqual(["既定", "無効"]);
  });

  it("clears an effort that the newly selected model does not support", async () => {
    getJson.mockImplementation((path: string) =>
      path === "/api/agents"
        ? Promise.resolve({
            agents: [{ ...agents[1], thinking: "high" }],
            agentsDir: "C:/pi/agent/agents",
          })
        : path === "/api/settings/auto-agent-prompt"
          ? Promise.resolve({ value: null })
          : Promise.resolve({ models }),
    );
    render(<AgentsSettings />);

    fireEvent.change(await screen.findByRole("combobox", { name: "enabled のモデル" }), {
      target: { value: "anthropic::claude" },
    });

    await waitFor(() => {
      expect(sendJson).toHaveBeenCalledWith(
        "/api/agents/enabled",
        { model: "anthropic/claude", thinking: null },
        "PATCH",
      );
    });
  });

  it("falls back to every effort level when the agent has no pinned model", async () => {
    render(<AgentsSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "disabled のEffort" }));

    const labels = within(screen.getByRole("listbox", { name: "disabled のEffort" }))
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(labels).toContain("max");
    expect(labels).toContain("xhigh");
  });

  it("saves an explicit thinking:false as the disabled effort", async () => {
    render(<AgentsSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "enabled のEffort" }));
    fireEvent.click(
      within(screen.getByRole("listbox", { name: "enabled のEffort" })).getByRole("option", {
        name: "無効",
      }),
    );

    await waitFor(() => {
      expect(sendJson).toHaveBeenCalledWith(
        "/api/agents/enabled",
        { thinking: false },
        "PATCH",
      );
    });
  });

  it("shows every subagent without an internal scroll container", async () => {
    render(<AgentsSettings />);

    const agentSwitch = await screen.findByRole("switch", { name: "enabled を無効化" });
    const list = agentSwitch.closest("ul");
    expect(list?.className).not.toContain("max-h-");
    expect(list?.className).not.toContain("overflow-y-auto");
    expect(list?.classList.contains("grid-cols-1")).toBe(true);
    expect(list?.className).toContain("@xl:grid-cols-2");
    expect(screen.getAllByRole("listitem")).toHaveLength(agents.length);
  });

  it("一覧の前でエージェントを作成し、キャンセル後に起点へフォーカスを戻す", async () => {
    render(<AgentsSettings />);

    const agentSwitch = await screen.findByRole("switch", { name: "enabled を無効化" });
    const createButton = screen.getByRole("button", { name: "＋新規" });
    fireEvent.click(createButton);

    const nameInput = screen.getByRole("textbox", { name: "名前" });
    const editorHeading = screen.getByRole("heading", { name: "新規エージェント" });
    const list = agentSwitch.closest("ul");
    expect(list).not.toBeNull();
    expect(document.activeElement).toBe(nameInput);
    expect(editorHeading.compareDocumentPosition(list!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

    // Inheritance is a mode, not a fabricated fixed allowlist.
    const editor = editorHeading.closest("section");
    expect(editor).not.toBeNull();
    expect(within(editor!).getByText("既定を継承")).toBeTruthy();
    expect(within(editor!).queryAllByRole("checkbox")).toHaveLength(0);
    expect(within(editor!).getByRole("button", { name: "新規エージェント のEffort" })).toBeTruthy();

    const autoHeading = screen.getByRole("heading", { name: "Autoエージェント" });
    expect(autoHeading.compareDocumentPosition(list!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(document.activeElement).toBe(createButton);
  });

  it("saves inheritance after switching a new draft to deny-all and back", async () => {
    render(<AgentsSettings />);
    await screen.findByRole("switch", { name: "enabled を無効化" });
    fireEvent.click(screen.getByRole("button", { name: "＋新規" }));
    const editor = screen.getByRole("heading", { name: "新規エージェント" }).closest("section")!;
    fireEvent.change(within(editor).getByRole("textbox", { name: "名前" }), { target: { value: "new-agent" } });
    fireEvent.click(within(editor).getByRole("button", { name: "個別に制限（許可なしから選択）" }));
    expect(within(editor).getByText("許可なし")).toBeTruthy();
    fireEvent.click(within(editor).getByRole("button", { name: "既定を継承に戻す" }));
    fireEvent.click(within(editor).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith("/api/agents", expect.objectContaining({ name: "new-agent", tools: undefined }), "POST"));
  });

  it("saves a new explicit deny-all draft as []", async () => {
    render(<AgentsSettings />);
    await screen.findByRole("switch", { name: "enabled を無効化" });
    fireEvent.click(screen.getByRole("button", { name: "＋新規" }));
    const editor = screen.getByRole("heading", { name: "新規エージェント" }).closest("section")!;
    fireEvent.change(within(editor).getByRole("textbox", { name: "名前" }), { target: { value: "blocked" } });
    fireEvent.click(within(editor).getByRole("button", { name: "個別に制限（許可なしから選択）" }));
    fireEvent.click(within(editor).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith("/api/agents", expect.objectContaining({ name: "blocked", tools: [] }), "POST"));
  });

  it.each([
    { initialTools: undefined, reset: false, expectedTools: undefined },
    { initialTools: [] as string[], reset: false, expectedTools: [] },
    { initialTools: [] as string[], reset: true, expectedTools: undefined },
  ])("roundtrips an existing user draft without changing inheritance/deny-all: %j", async ({ initialTools, reset, expectedTools }) => {
    const agent = { ...agents[1], id: "user", name: "user", source: "user", tools: initialTools };
    getJson.mockImplementation((path: string) => path === "/api/agents"
      ? Promise.resolve({ agents: [agent] }) : path === "/api/agents/user"
        ? Promise.resolve({ draft: { name: "user", systemPrompt: "Prompt", tools: initialTools } })
        : path === "/api/settings/auto-agent-prompt"
          ? Promise.resolve({ value: null }) : Promise.resolve({ models }));
    render(<AgentsSettings />);
    const row = (await screen.findByRole("switch", { name: "user を無効化" })).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "編集" }));
    const editor = (await screen.findByRole("heading", { name: "編集: user" })).closest("section")!;
    if (reset) fireEvent.click(within(editor).getByRole("button", { name: "既定を継承に戻す" }));
    fireEvent.click(within(editor).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith("/api/agents/user", expect.objectContaining({ name: "user", tools: expectedTools }), "PATCH"));
  });

  it("exposes Jev routing options for Auto agent selection", async () => {
    render(<AgentsSettings />);

    fireEvent.click(await screen.findByRole("switch", { name: "Jevルーティングを有効化" }));
    fireEvent.change(screen.getByLabelText("Jevルーティングの最低信頼度"), {
      target: { value: "0.75" },
    });

    await waitFor(() => expect(sendJson).toHaveBeenCalledWith(
      "/api/settings/auto-jev-enabled",
      { value: "1" },
      "PUT",
    ));
    expect(sendJson).toHaveBeenCalledWith(
      "/api/settings/auto-jev-min-confidence",
      { value: "0.75" },
      "PUT",
    );
  });

  it("shows the Auto prompt and enters edit mode from the 編集 button", async () => {
    render(<AgentsSettings />);

    expect(screen.queryByRole("textbox", { name: "モデル選定者向けプロンプト" })).toBeNull();
    const autoSection = screen.getByRole("heading", { name: "Autoエージェント" }).closest("section");
    expect(autoSection).not.toBeNull();
    expect(screen.getByRole("switch", { name: "Autoエージェントを有効化" }).closest("section")).toBe(autoSection);
    fireEvent.click(await screen.findByRole("button", { name: "編集" }));

    const prompt = screen.getByRole("textbox", { name: "モデル選定者向けプロンプト" }) as HTMLTextAreaElement;
    expect(prompt.value).toBe("既定の選定プロンプト\n{\"agent\":\"候補名\"}");
    expect(prompt.readOnly).toBe(false);

    fireEvent.change(prompt, { target: { value: "現在の依頼に最適な候補を選ぶ" } });
    sendJson.mockResolvedValueOnce({
      value: "現在の依頼に最適な候補を選ぶ",
      defaultPrompt: "既定の選定プロンプト\n{\"agent\":\"候補名\"}",
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(sendJson).toHaveBeenCalledWith(
        "/api/settings/auto-agent-prompt",
        { value: "現在の依頼に最適な候補を選ぶ" },
        "PUT",
      );
      expect(screen.queryByRole("textbox", { name: "モデル選定者向けプロンプト" })).toBeNull();
    });
  });
});
