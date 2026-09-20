"use client";

import { InstructionsMdSettings } from "@/components/settings/InstructionsMdSettings";

export function ToolsMdSettings() {
  return (
    <InstructionsMdSettings
      fileName="TOOLS.md"
      title="ツール運用（TOOLS.md）"
      endpoint="/api/tools-md"
      description={
        <>
          ツールの使い方・運用ルールです。Code は常時読み込まず、必要なタスクで <span className="font-mono">read</span> を使って読み込みます。
        </>
      }
      placeholder={"# ツール運用\n\n- 必要なときだけ読み込む\n- …"}
    />
  );
}
