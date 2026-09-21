"use client";

import { InstructionsMdSettings } from "@/components/settings/InstructionsMdSettings";

export function ToolsMdSettings() {
  return (
    <InstructionsMdSettings
      fileName="TOOLS.md"
      title="ツール運用（TOOLS.md）"
      endpoint="/api/tools-md"
      placeholder={"# ツール運用\n\n- 必要なときだけ読み込む\n- …"}
    />
  );
}
