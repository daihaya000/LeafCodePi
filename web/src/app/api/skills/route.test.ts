import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  reloadLiveSessionsContext: vi.fn(),
}));
const skills = vi.hoisted(() => ({
  listSkills: vi.fn(),
  setSkillsEnabled: vi.fn(),
  skillsErrorStatus: vi.fn(() => 500),
}));

vi.mock("@/lib/pi/harness", () => harness);
vi.mock("@/lib/skills", () => skills);

import { POST } from "./route";

function request(body: unknown): NextRequest {
  return new NextRequest("http://127.0.0.1:3010/api/skills", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/skills", () => {
  beforeEach(() => {
    skills.setSkillsEnabled.mockReset();
    skills.skillsErrorStatus.mockReset();
    skills.skillsErrorStatus.mockReturnValue(500);
    harness.reloadLiveSessionsContext.mockReset();
    harness.reloadLiveSessionsContext.mockReturnValue(Promise.resolve({ reloaded: 0, failed: 0, errors: [] }));
    skills.setSkillsEnabled.mockReturnValue({
      skills: [
        { id: "slack-api", name: "slack-api", enabled: false, codeEnabled: true, botEnabled: false },
        { id: "slack-cli", name: "slack-cli", enabled: false, codeEnabled: true, botEnabled: false },
      ],
    });
  });

  it("updates a skill group in one state operation", async () => {
    const response = await POST(request({
      names: ["slack-api", "slack-cli"],
      enabled: false,
      scope: "bot",
    }));

    expect(skills.setSkillsEnabled).toHaveBeenCalledWith(
      ["slack-api", "slack-cli"],
      false,
      undefined,
      { scope: "bot" },
    );
    expect(await response.json()).toMatchObject({
      ok: true,
      names: ["slack-api", "slack-cli"],
      enabled: false,
      scope: "bot",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(harness.reloadLiveSessionsContext).toHaveBeenCalledOnce();
  });

  it("rejects an empty skill group", async () => {
    const response = await POST(request({ names: [], enabled: false }));
    expect(response.status).toBe(400);
    expect(skills.setSkillsEnabled).not.toHaveBeenCalled();
  });
});
