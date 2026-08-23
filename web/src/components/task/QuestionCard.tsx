"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { HelpCircle } from "lucide-react";
import { Button, cx } from "@/components/ui";
import type { QuestionRequestDto } from "@/lib/types";

/** 本家 LeafCode の QuestionCard を移植（1 リクエスト = 質問 1 件の Pi 版）。 */
export function QuestionCard({
  request,
  onReply,
  onReject,
}: {
  request: QuestionRequestDto;
  onReply: (request: QuestionRequestDto, answers: string[][]) => Promise<void>;
  onReject: (request: QuestionRequestDto) => Promise<void>;
}) {
  const [busy, setBusy] = useState<"reply" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [custom, setCustom] = useState("");
  const requestGenerationRef = useRef(0);

  useEffect(() => {
    requestGenerationRef.current += 1;
    setBusy(null);
    setError(null);
    setSelected([]);
    setCustom("");
  }, [request.id]);

  // `custom` は明示的に false のときだけ無効（本家と同じ）。
  const customEnabled = request.questions[0]?.custom !== false;
  const question = request.questions[0];

  const canSubmit = useMemo(() => {
    if (!question) return false;
    if (selected.length > 0) return true;
    return customEnabled && custom.trim().length > 0;
  }, [question, selected, customEnabled, custom]);

  const buildAnswer = (): string[][] => {
    const picks = [...selected];
    const value = custom.trim();
    if (customEnabled && value && !picks.includes(value)) picks.push(value);
    return [picks];
  };

  const reply = async (answers?: string[][]) => {
    if (busy !== null) return;
    setBusy("reply");
    setError(null);
    try {
      await onReply(request, answers ?? buildAnswer());
    } catch (err) {
      setError(err instanceof Error ? err.message : "回答に失敗しました");
    } finally {
      setBusy(null);
    }
  };

  const reject = async () => {
    if (busy !== null) return;
    setBusy("reject");
    setError(null);
    try {
      await onReject(request);
    } catch (err) {
      setError(err instanceof Error ? err.message : "拒否に失敗しました");
    } finally {
      setBusy(null);
    }
  };

  const toggle = (label: string) => {
    setSelected((prev) =>
      question?.multiple
        ? prev.includes(label)
          ? prev.filter((x) => x !== label)
          : [...prev, label]
        : prev.includes(label)
          ? []
          : [label],
    );
  };

  // 単一質問・単一選択の選択肢クリックは即回答（本家の quick reply と同じ）。
  const quickReply = (label: string) => {
    if (busy !== null) return;
    if (question?.multiple || request.questions.length !== 1) {
      toggle(label);
      return;
    }
    void reply([[label]]);
  };

  const needsSubmitButton =
    !question || question.multiple === true || customEnabled;

  if (!question) return null;

  return (
    <div
      className="mx-auto max-w-5xl rounded-lg border border-accent/40 bg-surface px-3 py-3 text-sm"
      role="alertdialog"
      aria-label="確認が必要です"
    >
      <div className="mb-1 flex items-center gap-1.5 text-sm font-medium text-accent">
        <HelpCircle className="h-4 w-4" />
        確認が必要です
      </div>
      {question.header && (
        <p className="text-xs font-medium text-faint">{question.header}</p>
      )}
      <p className="mb-2 break-words text-text">{question.question}</p>
      {question.options.length > 0 && (
        <div
          className="mb-2 flex flex-col gap-1.5"
          role={question.multiple ? "group" : "radiogroup"}
          aria-label={question.header ?? question.question}
          aria-multiselectable={question.multiple || undefined}
        >
          {question.options.map((opt) => {
            const on = selected.includes(opt.label);
            return (
              <button
                key={opt.label}
                type="button"
                disabled={busy !== null}
                role={question.multiple ? "checkbox" : "radio"}
                aria-checked={on}
                onClick={() => quickReply(opt.label)}
                className={cx(
                  "cursor-pointer rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-50",
                  on
                    ? "border-accent bg-accent/10 text-text"
                    : "border-border bg-surface-2 text-muted hover:border-border-strong hover:text-text",
                )}
              >
                <span className="block text-sm font-medium">{opt.label}</span>
                {opt.description && (
                  <span className="mt-0.5 block text-xs text-faint">
                    {opt.description}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
      {customEnabled && (
        <input
          type="text"
          value={custom}
          disabled={busy !== null}
          aria-label={`${question.header ?? question.question}（自由入力）`}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            const value = custom.trim();
            if (!value) return;
            // 単一質問なら Enter で即回答（本家と同じ）。
            if (question.options.length === 0 || !question.multiple) {
              void reply([[value]]);
            }
          }}
          placeholder={
            question.options.length > 0 ? "その他（自由入力）" : "自由に入力してください"
          }
          className="mb-2 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none placeholder:text-muted focus:border-border-strong"
        />
      )}
      <div className="flex flex-wrap gap-2">
        {needsSubmitButton && (
          <Button
            variant="primary"
            size="sm"
            disabled={busy !== null || !canSubmit}
            onClick={() => void reply()}
          >
            回答する
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={busy !== null}
          onClick={() => void reject()}
        >
          キャンセル
        </Button>
      </div>
      {error && (
        <p className="mt-2 text-xs text-danger" role="alert" aria-live="assertive">
          {error}
        </p>
      )}
    </div>
  );
}
