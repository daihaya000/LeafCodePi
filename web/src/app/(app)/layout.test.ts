import { describe, expect, it, vi } from "vitest";

const snapshot = vi.hoisted(() => ({ readSettingsSnapshot: vi.fn() }));
vi.mock("@/lib/pi/settings-snapshot", () => snapshot);
vi.mock("@/components/shell/MainLayoutClient", () => ({ MainLayoutClient: () => null }));

import MainLayout from "./layout";

describe("(app) layout", () => {
  it("embeds the server settings snapshot", () => {
    snapshot.readSettingsSnapshot.mockReturnValue({ "composer-defaults": "{}" });
    const element = MainLayout({ children: null });
    expect(element.props.initialSettings).toEqual({ "composer-defaults": "{}" });
  });

  it("falls back to client fetch when the snapshot cannot be read", () => {
    snapshot.readSettingsSnapshot.mockImplementation(() => {
      throw new Error("EBUSY");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const element = MainLayout({ children: null });
    expect(element.props.initialSettings).toBeUndefined();
    warn.mockRestore();
  });
});