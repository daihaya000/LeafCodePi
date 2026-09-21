"use client";

import { InstructionsMdSettings } from "@/components/settings/InstructionsMdSettings";

export function BotsMdSettings() {
  return (
    <InstructionsMdSettings
      fileName="BOTS.md"
      title="共通指示（BOTS.md）"
      endpoint="/api/bots-md"
      placeholder={"# ボット共通指示\n\n- 日本語で簡潔に答える\n- …"}
    />
  );
}
