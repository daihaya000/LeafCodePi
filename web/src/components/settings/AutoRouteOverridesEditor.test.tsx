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
});
