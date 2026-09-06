// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutoRouteOverridesEditor } from "./AutoRouteOverridesEditor";

describe("AutoRouteOverridesEditor", () => {
  afterEach(cleanup);

  it("adds a connected model candidate to the selected tier", () => {
    const onChange = vi.fn();
    render(
      <AutoRouteOverridesEditor
        mode="cost"
        config={{ version: 2, modes: {} }}
        models={[
          {
            value: "provider::model-a",
            label: "Model A",
            providerID: "provider",
            modelID: "model-a",
            thinkingLevels: ["low"],
          },
        ]}
        onChange={onChange}
      />,
    );

    expect(screen.getAllByRole("button", { name: "候補を追加" })).toHaveLength(9);
    fireEvent.click(screen.getAllByRole("button", { name: "候補を追加" })[0]!);

    expect(onChange).toHaveBeenCalledWith({
      version: 2,
      modes: {
        cost: {
          light: {
            candidates: [
              { kind: "model", providerID: "provider", modelID: "model-a" },
            ],
          },
        },
      },
    });
  });

  it("uses touch-sized controls and disables both reorder boundaries", () => {
    const onChange = vi.fn();
    render(
      <AutoRouteOverridesEditor
        mode="cost"
        config={{
          version: 2,
          modes: {
            cost: {
              light: {
                candidates: [
                  { kind: "model", providerID: "provider", modelID: "model-a" },
                  { kind: "model", providerID: "provider", modelID: "model-b" },
                ],
              },
            },
          },
        }}
        models={[
          { value: "provider::model-a", label: "Model A", providerID: "provider", modelID: "model-a" },
          { value: "provider::model-b", label: "Model B", providerID: "provider", modelID: "model-b" },
        ]}
        onChange={onChange}
      />,
    );

    const modelButton = screen.getByRole("button", { name: "候補1のモデル" });
    expect(modelButton.parentElement?.className).toContain("w-full");
    const firstUp = screen.getByRole("button", { name: "候補1を上へ" }) as HTMLButtonElement;
    const firstDown = screen.getByRole("button", { name: "候補1を下へ" }) as HTMLButtonElement;
    const lastDown = screen.getByRole("button", { name: "候補2を下へ" }) as HTMLButtonElement;
    expect(firstUp.disabled).toBe(true);
    expect(lastDown.disabled).toBe(true);
    expect(firstDown.className).toContain("h-11");

    fireEvent.click(firstDown);
    expect(onChange).toHaveBeenCalledWith({
      version: 2,
      modes: {
        cost: {
          light: {
            candidates: [
              { kind: "model", providerID: "provider", modelID: "model-b" },
              { kind: "model", providerID: "provider", modelID: "model-a" },
            ],
          },
        },
      },
    });
  });

  it("shows all modes and tiers in a three-by-three layout", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <AutoRouteOverridesEditor
        mode="cost"
        config={{ version: 2, modes: {} }}
        models={[]}
        onChange={onChange}
      />,
    );
    const modeGrid = screen.getByRole("group", { name: "Auto ルーティング設定一覧" });
    expect(modeGrid.className).toContain("grid-cols-1");
    expect(modeGrid.className).toContain("lg:grid-cols-3");
    expect(Array.from(modeGrid.children).every((column) => column.className.includes("border"))).toBe(true);
    expect(within(modeGrid).getAllByRole("button", { name: "候補を追加" })).toHaveLength(9);
    const modeLabels = () =>
      Array.from(modeGrid.children).map((column) => column.querySelector("p")?.textContent ?? "");
    expect(modeLabels()).toEqual(["コスト優先*", "バランス", "知能優先"]);

    rerender(
      <AutoRouteOverridesEditor
        mode="intelligence"
        config={{ version: 2, modes: {} }}
        models={[]}
        onChange={onChange}
      />,
    );
    expect(modeLabels()).toEqual(["コスト優先", "バランス", "知能優先*"]);
  });

  it("offers a global reset only when an override exists", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <AutoRouteOverridesEditor
        mode="cost"
        config={{ version: 2, modes: {} }}
        models={[]}
        onChange={onChange}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "全モードの設定をリセット" }),
    ).toBeNull();

    rerender(
      <AutoRouteOverridesEditor
        mode="cost"
        config={{
          version: 2,
          modes: {
            cost: {
              light: {
                candidates: [{ kind: "model", providerID: "p", modelID: "m" }],
              },
            },
          },
        }}
        models={[]}
        onChange={onChange}
      />,
    );
    const reset = screen.getByRole("button", { name: "全モードの設定をリセット" });
    fireEvent.click(reset);
    expect(onChange).toHaveBeenCalledWith({ version: 2, modes: {} });
  });
});
