"use client";

import { InstructionsMdSettings } from "@/components/settings/InstructionsMdSettings";

export function DesignMdSettings() {
  return (
    <InstructionsMdSettings
      fileName="DESIGN.md"
      title="UIデザイン（DESIGN.md）"
      endpoint="/api/design-md"
      description={
        <>
          UIのデザインシステムです。Code は常時読み込まず、UI変更が必要なときに <span className="font-mono">read</span> を使って読み込みます。
        </>
      }
      placeholder={"# UIデザイン\n\n- 色・余白・タイポグラフィの規約\n- …"}
    />
  );
}
