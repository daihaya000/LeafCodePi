import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  reloadLiveSessionsContext: vi.fn(),
}));
const skills = vi.hoisted(() => ({
  setSkillEnabled: vi.fn(),
  skillsErrorStatus: vi.fn(() => 500),
}));

vi.mock("@/lib/pi/harness", () => harness);
vi.mock("@/lib/skills", () => skills);

import { PATCH } from "./route";

function request(body: unknown): NextRequest {
  return new NextRequest("http://127.0.0.1:3010/api/skills/review", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function context() {
  return { params: Promise.resolve({ name: "review" }) };
}

describe("/api/skills/:name", () => {
  beforeEach(() => {
    skills.setSkillEnabled.mockReset();
    skills.skillsErrorStatus.mockReset();
    skills.skillsErrorStatus.mockReturnValue(500);
    harness.reloadLiveSessionsContext.mockReset();
    skills.setSkillEnabled.mockReturnValue({
      skills: [{ id: "review", name: "review", enabled: false, codeEnabled: true, botEnabled: false }],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ライブセッションの再読込完了を待たずに状態を返す", async () => {
    let resolveReload!: (value: unknown) => void;
    const reload = new Promise((resolve) => {
      resolveReload = resolve;
    });
    harness.reloadLiveSessionsContext.mockReturnValueOnce(reload);

    const responsePromise = PATCH(request({ enabled: false, scope: "bot" }), context());
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timeoutTimer = setTimeout(() => resolve(null), 25);
    });
    const response = await Promise.race([responsePromise, timeout]);
    if (timeoutTimer) clearTimeout(timeoutTimer);

    expect(response).not.toBeNull();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(harness.reloadLiveSessionsContext).toHaveBeenCalledOnce();
    expect(skills.setSkillEnabled).toHaveBeenCalledWith("review", false, undefined, { scope: "bot" });
    expect(await (response as Response).json()).toMatchObject({
      ok: true,
      name: "review",
      enabled: false,
      scope: "bot",
    });

    resolveReload({ reloaded: 1, failed: 0, errors: [] });
    await responsePromise;
  });
});
