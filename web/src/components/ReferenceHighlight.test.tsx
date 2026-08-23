// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ReferenceHighlight } from "./ReferenceHighlight";

describe("ReferenceHighlight", () => {
  afterEach(cleanup);

  it("highlights known agent and skill references in sent text", () => {
    const view = render(
      <ReferenceHighlight
        text="@debugger 呼び出しテスト /skill:bug-hunt"
        references={{
          agents: [{ name: "debugger" }],
          skills: [{ name: "bug-hunt" }],
        }}
      />,
    );

    expect(view.container.querySelector(".text-primary")?.textContent).toBe("@debugger");
    expect(view.container.querySelector(".text-accent")?.textContent).toBe("/skill:bug-hunt");
    expect(view.container.textContent).toBe("@debugger 呼び出しテスト /skill:bug-hunt");
  });

  it("leaves unknown references unstyled", () => {
    const view = render(
      <ReferenceHighlight
        text="@unknown /skill:missing"
        references={{ agents: [], skills: [] }}
      />,
    );

    expect(view.container.querySelector(".text-primary")).toBeNull();
    expect(view.container.querySelector(".text-accent")).toBeNull();
    expect(view.container.textContent).toBe("@unknown /skill:missing");
  });
});
