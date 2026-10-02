"use client";

import { Zap } from "lucide-react";
import { GhostSelect } from "@/components/ui";
import { supportsOpenAiFastMode } from "@/lib/openai-fast-mode";
import { useOpenAiFastMode } from "@/lib/use-openai-fast-mode";

/** OpenAI系モデルのときだけ表示する Fast モード（優先処理）の切替。設定は全体共通。 */
export function FastModeSelect({
  providerID,
  disabled = false,
  className = "max-w-[7rem] shrink-0",
}: {
  providerID: string | null | undefined;
  disabled?: boolean;
  className?: string;
}) {
  const supported = supportsOpenAiFastMode(providerID);
  const { enabled, update } = useOpenAiFastMode(supported);
  if (!supported) return null;

  return (
    <GhostSelect
      value={enabled ? "fast" : "standard"}
      disabled={disabled}
      aria-label="処理速度"
      title="Fastモード（優先処理）。料金は約2倍になります"
      icon={<Zap className="h-3.5 w-3.5" />}
      valueLabel={enabled ? "Fast" : "標準"}
      tone={enabled ? "warning" : "default"}
      onChange={(next) => void update(next === "fast")}
      className={className}
    >
      <option value="standard">標準</option>
      <option value="fast">Fast</option>
    </GhostSelect>
  );
}
