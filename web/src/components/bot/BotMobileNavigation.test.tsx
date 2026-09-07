// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getJson: vi.fn(),
  push: vi.fn(),
}));

vi.mock("@/lib/client", () => ({ getJson: mocks.getJson, sendJson: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: ReactNode; [key: string]: unknown }) => <a {...props}>{children}</a>,
}));
vi.mock("next/image", () => ({
  default: () => <span data-testid="next-image" />,
}));

import { BotChatHeader } from "./BotChatHeader";
import { BotListView } from "./BotListView";
import { ShellProvider, useShellMobileNav } from "@/components/shell/ShellContext";

function NavState() {
  const { mobileNavOpen } = useShellMobileNav();
  return <output data-testid="mobile-nav-state">{mobileNavOpen ? "open" : "closed"}</output>;
}

function renderWithShell(ui: ReactNode) {
  return render(
    <ShellProvider>
      {ui}
      <NavState />
    </ShellProvider>,
  );
}

beforeEach(() => {
  mocks.getJson.mockResolvedValue({ bots: [] });
});

afterEach(() => {
  cleanup();
  mocks.getJson.mockReset();
  mocks.push.mockReset();
});

describe("Bot mode mobile navigation", () => {
  it("opens the mobile menu from a bot chat header", () => {
    renderWithShell(
      <BotChatHeader
        title="Alpha"
        subtitle="一対一 ボット"
        settingsOpen={false}
        onSettings={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "メニュー" }));

    expect(screen.getByTestId("mobile-nav-state").textContent).toBe("open");
  });

  it("opens the mobile menu from the bot list", () => {
    renderWithShell(<BotListView />);

    fireEvent.click(screen.getByRole("button", { name: "メニュー" }));

    expect(screen.getByTestId("mobile-nav-state").textContent).toBe("open");
  });
});
