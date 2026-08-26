// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountSelect } from "./AccountSelect";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("AccountSelect", () => {
  it("renders nothing when no accounts exist", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ accounts: [] }));
    const onChange = vi.fn();
    render(<AccountSelect value={null} onChange={onChange} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // accounts 取得完了後は非表示（既定のみの運用ではノイズになるため）
    await waitFor(() => {
      expect(screen.queryByLabelText("アカウント")).toBeNull();
    });
  });

  it("lists the default and registered accounts, reporting selection", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        accounts: [
          { id: "acc-1", label: "仕事用" },
          { id: "acc-2", label: "個人用" },
        ],
      }),
    );
    const onChange = vi.fn();
    render(<AccountSelect value={null} onChange={onChange} />);

    // 既定ラベルのトリガーを開く
    const trigger = await screen.findByText("既定");
    fireEvent.click(trigger.closest("button")!);

    const option = await screen.findByRole("option", { name: "個人用" });
    fireEvent.click(option);

    expect(onChange).toHaveBeenCalledWith("acc-2");
  });

  it("shows the selected account label as the trigger label", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ accounts: [{ id: "acc-1", label: "仕事用" }] }),
    );
    render(<AccountSelect value="acc-1" onChange={vi.fn()} />);
    expect(await screen.findByText("仕事用")).toBeTruthy();
  });
});
