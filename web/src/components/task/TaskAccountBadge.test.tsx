// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskAccountBadge } from "./TaskAccountBadge";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TaskAccountBadge", () => {
  it("renders nothing for the default account (no accountId)", () => {
    const { container } = render(<TaskAccountBadge accountId={undefined} />);
    expect(container.textContent).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves the account label from /api/accounts", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ accounts: [{ id: "acc-1", label: "仕事用" }] }), {
        headers: { "content-type": "application/json" },
      }),
    );
    render(<TaskAccountBadge accountId="acc-1" />);
    expect(await screen.findByText("仕事用")).toBeTruthy();
  });

  it("falls back to the raw id when the lookup fails or misses", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    render(<TaskAccountBadge accountId="acc-9" />);
    await waitFor(() => expect(screen.getByText("acc-9")).toBeTruthy());
  });
});
