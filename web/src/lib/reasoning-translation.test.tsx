// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetReasoningTranslationForTest,
  readReasoningTranslationMode,
  useReasoningTranslation,
  writeReasoningTranslationMode,
} from "./reasoning-translation";

function TranslationProbe({ id, text }: { id: string; text: string }) {
  const { translated } = useReasoningTranslation(text);
  return <output data-testid={id}>{translated ?? ""}</output>;
}

describe("reasoning translation scheduler", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockClear();
    localStorage.setItem("webui:reasoning-translation-mode", "translated");
    fetchMock.mockImplementation(async (_input: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { texts: string[] };
      return {
        ok: true,
        json: async () => ({
          translations: body.texts.map((text) => `訳:${text}`),
          fallbacks: body.texts.map(() => false),
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    __resetReasoningTranslationForTest();
  });

  afterEach(() => {
    cleanup();
    __resetReasoningTranslationForTest();
    vi.unstubAllGlobals();
    localStorage.clear();
    vi.useRealTimers();
  });

  it("defaults to the original text when no display preference is stored", () => {
    localStorage.removeItem("webui:reasoning-translation-mode");

    expect(readReasoningTranslationMode()).toBe("original");
  });

  it("returns original when localStorage reads throw", () => {
    const spy = vi
      .spyOn(window.localStorage, "getItem")
      .mockImplementation(() => {
        throw new Error("storage blocked");
      });
    expect(readReasoningTranslationMode()).toBe("original");
    spy.mockRestore();
  });

  it("does not throw when localStorage writes are blocked", () => {
    const spy = vi
      .spyOn(window.localStorage, "setItem")
      .mockImplementation(() => {
        throw new Error("quota exceeded");
      });
    expect(() => writeReasoningTranslationMode("translated")).not.toThrow();
    spy.mockRestore();
  });

  it("batches a long timeline instead of sending one request per reasoning part", async () => {
    const texts = Array.from({ length: 20 }, (_, index) => `Reasoning ${index}`);
    render(
      <>
        {texts.map((text) => (
          <TranslationProbe key={text} id={text} text={text} />
        ))}
      </>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const payloads = fetchMock.mock.calls.map((call) =>
      JSON.parse(String(call[1]?.body)) as { texts: string[] },
    );
    expect(payloads.flatMap((payload) => payload.texts).sort()).toEqual(texts.sort());
    expect(payloads.every((payload) => payload.texts.length <= 16)).toBe(true);
    expect(screen.getByTestId("Reasoning 0").textContent).toBe("訳:Reasoning 0");
  });

  it("removes a session's queued translations when its timeline unmounts", async () => {
    const view = render(<TranslationProbe id="old" text="Old session reasoning" />);
    view.unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("translates only the English paragraphs of a mixed en/ja reasoning text", async () => {
    const mixed =
      "variant is a free-form optional string.\n\n" +
      "二重タイムアウトのリスクは許容範囲だが、forループの手動管理は過剰設計かもしれない。\n\n" +
      "The more practical fix: add a single automatic retry.";
    render(<TranslationProbe id="mixed" text={mixed} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      texts: string[];
    };
    // Both English paragraphs are sent; the Japanese paragraph is not.
    expect(payload.texts).toHaveLength(2);
    expect(payload.texts.some((t) => t.includes("二重タイムアウト"))).toBe(false);

    const output = screen.getByTestId("mixed").textContent ?? "";
    // English paragraphs are translated.
    expect(output).toContain("訳:variant is a free-form optional string");
    expect(output).toContain("訳:The more practical fix");
    // Japanese paragraph is preserved verbatim.
    expect(output).toContain("二重タイムアウトのリスクは許容範囲");
  });

  it("leaves fenced code blocks untranslated inside reasoning prose", async () => {
    const withCode =
      "Checking EffortSelect options.\n\n" +
      "```ts\nconst variantEnabled = true;\n```\n\n" +
      "Writing batch loop logic.";
    render(<TranslationProbe id="with-code" text={withCode} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });

    const output = screen.getByTestId("with-code").textContent ?? "";
    // Code block is preserved verbatim.
    expect(output).toContain("const variantEnabled = true;");
    // Surrounding English prose is translated.
    expect(output).toContain("訳:Checking EffortSelect options");
    expect(output).toContain("訳:Writing batch loop logic");
  });

  it("preserves inline code spans while translating surrounding prose", async () => {
    const inline = "Checking whether `auto` exists as an option in EffortSelect.";
    render(<TranslationProbe id="inline" text={inline} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });

    const output = screen.getByTestId("inline").textContent ?? "";
    // Inline code is restored after translation.
    expect(output).toContain("`auto`");
    expect(output).not.toMatch(/\u0001\d+\u0001/);
  });

  it("skips translation when every paragraph is already Japanese", async () => {
    const japanese =
      "二重タイムアウトのリスクは許容範囲だ。\n\n最終的にbreakする構造なので安全だ。";
    render(<TranslationProbe id="japanese" text={japanese} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
