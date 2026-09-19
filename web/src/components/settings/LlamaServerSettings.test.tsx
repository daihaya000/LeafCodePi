// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LLAMA_SERVER_SETTINGS,
  LLAMA_MODEL_PRESETS,
} from "@/lib/llama-server-settings";
import { LlamaServerSettings } from "./LlamaServerSettings";

const { getJson, sendJson } = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
}));

vi.mock("@/lib/client", () => ({ getJson, sendJson }));

describe("LlamaServerSettings", () => {
  beforeEach(() => {
    getJson.mockImplementation((path: string) => {
      if (path === "/api/settings/llama-server-config") {
        return Promise.resolve({ parsed: { ...DEFAULT_LLAMA_SERVER_SETTINGS } });
      }
      if (path === "/api/llama-server/models") {
        return Promise.resolve({ models: [], mmprojs: [], defaultModel: null, dir: null });
      }
      if (path === "/api/llama-server/status") {
        return Promise.resolve({
          running: false,
          pid: null,
          listeningPids: [],
          health: null,
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

  it("非表示中は状態をポーリングせず、再表示時に取得する", async () => {
    const view = render(<LlamaServerSettings active={false} />);

    await waitFor(() => {
      expect(getJson).toHaveBeenCalledWith("/api/settings/llama-server-config");
    });
    expect(getJson).not.toHaveBeenCalledWith("/api/llama-server/status");

    view.rerender(<LlamaServerSettings active />);

    await waitFor(() => {
      expect(getJson).toHaveBeenCalledWith("/api/llama-server/status");
    });
  });

  it("保留中の設定をアンマウント時に保存する", async () => {
    const view = render(<LlamaServerSettings />);
    const family = await screen.findByLabelText("使用するモデル");
    const preset = LLAMA_MODEL_PRESETS[0]!;

    fireEvent.change(family, { target: { value: preset.key } });
    view.unmount();

    await waitFor(() => {
      expect(sendJson).toHaveBeenCalledWith(
        "/api/settings/llama-server-config",
        { value: expect.any(String) },
        "PUT",
      );
    });
    const body = sendJson.mock.calls[0]?.[1] as { value: string };
    expect(JSON.parse(body.value)).toMatchObject(preset.settings);
  });

  it("状態確認中は起動・停止ボタンを無効化し、確認完了後に有効化する", async () => {
    let resolveStatus!: (value: unknown) => void;
    getJson.mockImplementation((path: string) => {
      if (path === "/api/settings/llama-server-config") {
        return Promise.resolve({ parsed: { ...DEFAULT_LLAMA_SERVER_SETTINGS } });
      }
      if (path === "/api/llama-server/models") {
        return Promise.resolve({ models: [], defaultModel: null, dir: null });
      }
      if (path === "/api/llama-server/status") {
        return new Promise((resolve) => { resolveStatus = resolve; });
      }
      return Promise.reject(new Error(`unexpected path: ${path}`));
    });

    render(<LlamaServerSettings />);

    expect(await screen.findByText("確認中")).toBeTruthy();
    expect((screen.getByRole("button", { name: "起動" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "停止" }) as HTMLButtonElement).disabled).toBe(true);

    resolveStatus({ running: false, pid: null, listeningPids: [], health: null });

    await waitFor(() => {
      expect(screen.getByText("停止")).toBeTruthy();
    });
    expect((screen.getByRole("button", { name: "起動" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("設定読込中は起動設定フォームを無効化し、読込完了後に有効化する", async () => {
    let resolveConfig!: (value: { parsed: typeof DEFAULT_LLAMA_SERVER_SETTINGS }) => void;
    getJson.mockImplementation((path: string) => {
      if (path === "/api/settings/llama-server-config") {
        return new Promise((resolve) => { resolveConfig = resolve; });
      }
      if (path === "/api/llama-server/models") {
        return Promise.resolve({ models: [], defaultModel: null, dir: null });
      }
      if (path === "/api/llama-server/status") {
        return Promise.resolve({ running: false, pid: null, listeningPids: [], health: null });
      }
      return Promise.reject(new Error(`unexpected path: ${path}`));
    });

    render(<LlamaServerSettings />);

    const family = screen.getByLabelText("使用するモデル") as HTMLSelectElement;
    expect(family.disabled).toBe(true);
    expect(screen.getByText("設定を読み込んでいます…")).toBeTruthy();

    resolveConfig({ parsed: { ...DEFAULT_LLAMA_SERVER_SETTINGS } });

    await waitFor(() => {
      expect(family.disabled).toBe(false);
    });
    expect(screen.getByText("変更は自動で保存され、次回起動時に反映されます")).toBeTruthy();
  });

  it("連続保存時にPUTを直列化し、応答順序が逆転しても古い値で上書きしない", async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    sendJson.mockImplementation(() => new Promise((resolve) => { resolvers.push(resolve); }));

    render(<LlamaServerSettings />);
    const family = await screen.findByLabelText("使用するモデル");
    const [presetA, presetB] = LLAMA_MODEL_PRESETS;

    fireEvent.change(family, { target: { value: presetA!.key } });
    await waitFor(() => expect(sendJson).toHaveBeenCalledTimes(1), { timeout: 2000 });

    fireEvent.change(family, { target: { value: presetB!.key } });
    // 直列化されていれば、PUT Aが未解決の間はPUT BはsendJsonを呼ばない。
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(sendJson).toHaveBeenCalledTimes(1);

    resolvers[0]!({});
    await waitFor(() => expect(sendJson).toHaveBeenCalledTimes(2), { timeout: 2000 });
    const secondBody = sendJson.mock.calls[1]?.[1] as { value: string };
    expect(JSON.parse(secondBody.value)).toMatchObject(presetB!.settings);

    resolvers[1]!({});
    await waitFor(() => {
      expect(screen.getByText("設定を保存しました")).toBeTruthy();
    });
  });

  it("vision プリセットを選ぶと同フォルダの mmproj を設定する", async () => {
    const model = "Qwen3.8-27B-Uncensored-GGUF\\Qwen3.8-27B-Uncensored-Q4_K_S.gguf";
    const mmproj = "Qwen3.8-27B-Uncensored-GGUF\\mmproj-Qwen3.8-27B-BF16.gguf";
    getJson.mockImplementation((path: string) => {
      if (path === "/api/settings/llama-server-config") {
        return Promise.resolve({ parsed: { ...DEFAULT_LLAMA_SERVER_SETTINGS } });
      }
      if (path === "/api/llama-server/models") {
        return Promise.resolve({
          models: [model, "Ornith-1.5-35B-A3B-GGUF\\ornith.gguf"],
          mmprojs: [mmproj, "Ornith-1.5-35B-A3B-GGUF\\mmproj.gguf"],
          defaultModel: null,
          dir: "D:\\models\\llm",
        });
      }
      if (path === "/api/llama-server/status") {
        return Promise.resolve({ running: false, pid: null, listeningPids: [], health: null });
      }
      return Promise.reject(new Error(`unexpected path: ${path}`));
    });

    render(<LlamaServerSettings />);
    const family = await screen.findByLabelText("使用するモデル");
    fireEvent.change(family, { target: { value: "qwen38-uncensored" } });

    fireEvent.click(await screen.findByRole("button", { name: /詳細設定/ }));
    const select = (await screen.findByLabelText("Vision projector (mmproj)")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe(mmproj));
  });

  it("非表示から再表示した直後は確認中に戻り、古い状態で起動・停止できない", async () => {
    const view = render(<LlamaServerSettings active />);
    await waitFor(() => {
      expect(screen.getByText("停止")).toBeTruthy();
    });

    let resolveStatus!: (value: unknown) => void;
    getJson.mockImplementation((path: string) => {
      if (path === "/api/llama-server/status") {
        return new Promise((resolve) => { resolveStatus = resolve; });
      }
      return Promise.reject(new Error(`unexpected path: ${path}`));
    });

    view.rerender(<LlamaServerSettings active={false} />);
    view.rerender(<LlamaServerSettings active />);

    expect(await screen.findByText("確認中")).toBeTruthy();
    expect((screen.getByRole("button", { name: "起動" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "停止" }) as HTMLButtonElement).disabled).toBe(true);

    resolveStatus({ running: true, pid: 123, listeningPids: [123], health: "ok" });
    await waitFor(() => {
      expect(screen.getByText("実行中")).toBeTruthy();
    });
  });

  it("モデルと同じフォルダの mmproj を自動選択し、起動時に送信する", async () => {
    const mmproj = "repoA\\mmproj-model-BF16.gguf";
    getJson.mockImplementation((path: string) => {
      if (path === "/api/settings/llama-server-config") {
        return Promise.resolve({
          parsed: { ...DEFAULT_LLAMA_SERVER_SETTINGS, modelFile: "repoA\\model-Q4_K_S.gguf" },
        });
      }
      if (path === "/api/llama-server/models") {
        return Promise.resolve({
          models: ["repoA\\model-Q4_K_S.gguf"],
          mmprojs: [mmproj],
          defaultModel: null,
          dir: "D:\\models\\llm",
        });
      }
      if (path === "/api/llama-server/status") {
        return Promise.resolve({ running: false, pid: null, listeningPids: [], health: null });
      }
      return Promise.reject(new Error(`unexpected path: ${path}`));
    });

    render(<LlamaServerSettings />);
    fireEvent.click(await screen.findByRole("button", { name: /詳細設定/ }));

    const select = (await screen.findByLabelText("Vision projector (mmproj)")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe(mmproj));

    fireEvent.click(screen.getByRole("button", { name: "起動" }));
    await waitFor(() => {
      expect(sendJson).toHaveBeenCalledWith(
        "/api/llama-server/start",
        expect.objectContaining({ mmprojPath: mmproj }),
      );
    });
  });
});
