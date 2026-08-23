// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSelect } from "./AgentSelect";

describe("AgentSelect", () => {
  afterEach(cleanup);

  it("does not show the placeholder as a selectable agent", () => {
    render(<AgentSelect value="build" agents={["build", "programmer"]} onChange={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "エージェント" }));

    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "build",
      "programmer",
    ]);
    expect(screen.queryByRole("option", { name: "エージェント" })).toBeNull();
  });
});
