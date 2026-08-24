import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({
  readAutoResumeModeSetting: vi.fn(),
  readHangTimeoutSettingMs: vi.fn(),
  writeAutoResumeModeSetting: vi.fn(),
  writeHangTimeoutSettingMs: vi.fn(),
}));

vi.mock("@/lib/pi/hang-settings", () => settings);

import { GET, PATCH } from "./route";

function request(body: unknown): NextRequest {
  return new NextRequest("http://127.0.0.1:3010/api/settings/hang-timeout", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/settings/hang-timeout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings.readHangTimeoutSettingMs.mockReturnValue(300_000);
    settings.readAutoResumeModeSetting.mockReturnValue("same");
    settings.writeHangTimeoutSettingMs.mockImplementation((value: number) => value);
    settings.writeAutoResumeModeSetting.mockImplementation((value: string) => value);
  });

  it("returns the timeout and auto-resume mode", async () => {
    settings.readAutoResumeModeSetting.mockReturnValue("continue");

    const response = await GET();

    expect(await response.json()).toEqual({ timeoutMs: 300_000, resumeMode: "continue" });
  });

  it("updates only the requested mode", async () => {
    const response = await PATCH(request({ resumeMode: "continue" }));

    expect(response.status).toBe(200);
    expect(settings.writeAutoResumeModeSetting).toHaveBeenCalledWith("continue");
    expect(settings.writeHangTimeoutSettingMs).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ timeoutMs: 300_000, resumeMode: "continue" });
  });

  it("rejects an unknown mode", async () => {
    const response = await PATCH(request({ resumeMode: "later" }));

    expect(response.status).toBe(400);
    expect(settings.writeAutoResumeModeSetting).not.toHaveBeenCalled();
  });
});
