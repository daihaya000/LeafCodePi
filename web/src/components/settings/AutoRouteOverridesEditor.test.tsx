// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

    expect(screen.getAllByRole("button", { name: "候補を追加" })).toHaveLength(3);
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

  it("follows the external mode prop after a local mode switch", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <AutoRouteOverridesEditor
        mode="cost"
        config={{ version: 2, modes: {} }}
        models={[]}
        onChange={onChange}
      />,
    );
    // The editor keeps its own edit-mode, seeded from the prop. The active
    // (prop) mode is also marked with "*", so match by prefix.
    const pressedName = () =>
      screen
        .getAllByRole("button")
        .filter((button) => button.getAttribute("aria-pressed") === "true")
        .map((button) => button.textContent ?? "");
    expect(pressedName()).toEqual(["コスト優先*"]);
    // Locally switching to another mode is allowed.
    fireEvent.click(screen.getByRole("button", { name: "知能優先" }));
    expect(pressedName()).toEqual(["知能優先"]);
    // A later prop change wins again (useEffect(() => setEditMode(mode), [mode])).
    rerender(
      <AutoRouteOverridesEditor
        mode="balanced"
        config={{ version: 2, modes: {} }}
        models={[]}
        onChange={onChange}
      />,
    );
    expect(pressedName()).toEqual(["バランス*"]);
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
