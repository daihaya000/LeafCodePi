import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
  parseDirectModelKey: vi.fn(),
  buildDirectGenerationCandidates: vi.fn(),
  generateDirectTextWithFallbackResult: vi.fn(),
}));

vi.mock("@/lib/pi/web-settings", () => ({ getSetting: mocks.getSetting }));
vi.mock("@/lib/direct-generation", () => ({
  parseDirectModelKey: mocks.parseDirectModelKey,
  buildDirectGenerationCandidates: mocks.buildDirectGenerationCandidates,
  generateDirectTextWithFallbackResult: mocks.generateDirectTextWithFallbackResult,
}));

import {
  formatRoomOpenerPrompt,
  parseRoomOpenerResponse,
  resolveRoomOpener,
  roomOpenerCandidates,
} from "./room-opener";
import { roomOpenerReasonLabel } from "./room-opener-labels";
import type { BotDto } from "./types";

const designer = {
  id: "d",
  name: "Designer",
  label: "UI",
  enabled: true,
  soul: "デザインを担当",
} as BotDto;
const debuggerBot = {
  id: "x",
  name: "Debugger",
  label: "Debugging",
  enabled: true,
  soul: "バグを見つける",
} as BotDto;
const planner = {
  id: "p",
  name: "Planner",
  label: "Planning",
  enabled: true,
  soul: "方針を立てる",
} as BotDto;

beforeEach(() => {
  mocks.getSetting.mockReset();
  mocks.parseDirectModelKey.mockReset();
  mocks.buildDirectGenerationCandidates.mockReset();
  mocks.generateDirectTextWithFallbackResult.mockReset();
  mocks.getSetting.mockReturnValue(undefined);
  mocks.parseDirectModelKey.mockImplementation((key: string | undefined) =>
    key ? { providerID: "p", modelID: "m" } : undefined,
  );
});

describe("room opener candidates and parse", () => {
  it("builds name/label/SOUL candidates and parses strict agent JSON", () => {
    const candidates = roomOpenerCandidates([designer, debuggerBot, { ...planner, enabled: false }]);
    expect(candidates.map((c) => c.name)).toEqual(["Designer", "Debugger"]);
    expect(candidates[1]?.description).toContain("Debugging");
    expect(candidates[1]?.description).toContain("バグを見つける");

    const prompt = formatRoomOpenerPrompt("方針を決めて", candidates);
    expect(prompt).toContain("<current_request>");
    expect(prompt).toContain("方針を決めて");
    expect(prompt).toContain('"name":"Designer"');

    expect(parseRoomOpenerResponse('{"agent":"Debugger"}', candidates)).toBe("Debugger");
    expect(parseRoomOpenerResponse('{"agent":"missing"}', candidates)).toBeUndefined();
    expect(parseRoomOpenerResponse('{"agent":"Debugger","extra":1}', candidates)).toBeUndefined();
  });

  it("caps the routing request and each role summary", () => {
    const candidates = roomOpenerCandidates([{ ...designer, soul: "x".repeat(600) }]);
    const prompt = formatRoomOpenerPrompt("r".repeat(16_000), candidates);
    const current = prompt.match(/<current_request>\n([\s\S]*?)\n<\/current_request>/)?.[1] ?? "";

    expect(Array.from(current)).toHaveLength(8_000);
    expect(candidates[0]?.description).toHaveLength(300);
  });

  it("labels opener reasons for chips", () => {
    expect(roomOpenerReasonLabel("keyword")).toBe("キーワード一致");
    expect(roomOpenerReasonLabel("llm")).toBe("LLM選択");
  });
});

describe("resolveRoomOpener hybrid path", () => {
  it("uses confident v1 keyword first and skips the LLM", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    mocks.buildDirectGenerationCandidates.mockReturnValue([
      { model: { providerID: "p", modelID: "m" } },
    ]);
    try {
      await expect(
        resolveRoomOpener({ prompt: "バグを見つけて", bots: [designer, debuggerBot] }),
      ).resolves.toEqual({ bot: debuggerBot, reason: "keyword" });
      expect(mocks.generateDirectTextWithFallbackResult).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(
        "[room-opener] keyword skip LLM",
        JSON.stringify({ bot: "Debugger" }),
      );
    } finally {
      log.mockRestore();
    }
  });

  it("calls LLM only when keyword-uncertain and returns the picked bot", async () => {
    const model = { providerID: "p", modelID: "m" };
    mocks.getSetting.mockImplementation((key: string) =>
      key.includes("generation-model") && !key.includes("fallback") ? "p/m" : undefined,
    );
    mocks.buildDirectGenerationCandidates.mockReturnValue([{ model }]);
    mocks.generateDirectTextWithFallbackResult.mockResolvedValue({
      text: '{"agent":"Planner"}',
      model,
    });

    await expect(
      resolveRoomOpener({ prompt: "残作業も進めて", bots: [designer, planner] }),
    ).resolves.toEqual({ bot: planner, reason: "llm" });
    expect(mocks.generateDirectTextWithFallbackResult).toHaveBeenCalled();
    const call = mocks.generateDirectTextWithFallbackResult.mock.calls[0]?.[0];
    expect(call?.prompt).toContain("残作業も進めて");
    expect(call?.system).toContain("最初の発言者");
  });

  it("pins accountId when the caller supplies one", async () => {
    const model = { providerID: "p", modelID: "m" };
    mocks.getSetting.mockImplementation((key: string) =>
      key.includes("generation-model") && !key.includes("fallback") ? "p/m" : undefined,
    );
    mocks.buildDirectGenerationCandidates.mockReturnValue([{ model }]);
    mocks.generateDirectTextWithFallbackResult.mockResolvedValue({
      text: '{"agent":"Planner"}',
      model,
    });

    await resolveRoomOpener({
      prompt: "残作業も進めて",
      bots: [designer, planner],
      accountId: "acc-room",
    });

    expect(mocks.generateDirectTextWithFallbackResult).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc-room",
        accountIdExplicit: true,
      }),
    );
  });

  it("returns undefined on LLM failure so callers can rotate or not start", async () => {
    mocks.getSetting.mockImplementation((key: string) =>
      key.includes("generation-model") && !key.includes("fallback") ? "p/m" : undefined,
    );
    mocks.buildDirectGenerationCandidates.mockReturnValue([
      { model: { providerID: "p", modelID: "m" } },
    ]);
    mocks.generateDirectTextWithFallbackResult.mockRejectedValue(new Error("offline"));

    await expect(
      resolveRoomOpener({ prompt: "残作業も進めて", bots: [designer, planner] }),
    ).resolves.toBeUndefined();
  });

  it("returns undefined when no generation model is configured", async () => {
    mocks.buildDirectGenerationCandidates.mockReturnValue([]);
    await expect(
      resolveRoomOpener({ prompt: "残作業も進めて", bots: [designer, planner] }),
    ).resolves.toBeUndefined();
    expect(mocks.generateDirectTextWithFallbackResult).not.toHaveBeenCalled();
  });
});
