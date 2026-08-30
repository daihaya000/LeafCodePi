// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutoOptimizeSelect } from "./AutoOptimizeSelect";

describe("AutoOptimizeSelect", () => {
  afterEach(cleanup);

  it("shows the three optimization modes and reports a selection", () => {
    const onChange = vi.fn();
    render(<AutoOptimizeSelect value="cost" onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Auto の最適化" }));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "コスト優先",
      "バランス",
      "知能優先",
    ]);
    fireEvent.click(screen.getByRole("option", { name: "知能優先" }));
    expect(onChange).toHaveBeenCalledWith("intelligence");
  });
});
