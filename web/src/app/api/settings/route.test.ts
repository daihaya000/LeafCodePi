import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({ getSetting: vi.fn() }));
vi.mock("@/lib/pi/web-settings", () => ({ getSetting: settings.getSetting }));
vi.mock("@/lib/pi/hang-settings", () => ({
  readHangTimeoutSettingMs: () => 120_000,
  readAutoResumeModeSetting: () => "same",
}));
vi.mock("@/lib/accounts", () => ({ listAccounts: () => [] }));

import { GET } from "./route";

describe("/api/settings", () => {
  beforeEach(() => {
    settings.getSetting.mockReset();
  });

  it("returns every allowed setting plus hang settings in one response", async () => {
    settings.getSetting.mockImplementation((key: string) => (key === "composer-defaults" ? "{\"model\":\"p::m\"}" : null));

    const body = (await (await GET()).json()) as { values: Record<string, string | null> };

    expect(body.values["composer-defaults"]).toBe("{\"model\":\"p::m\"}");
    expect(body.values["scroll-button-opacity"]).toBeNull();
    expect(body.values["hang-timeout"]).toBe("120000");
    expect(body.values["auto-resume-mode"]).toBe("same");
  });
});