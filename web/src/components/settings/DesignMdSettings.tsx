"use client";

import { InstructionsMdSettings } from "@/components/settings/InstructionsMdSettings";

export function DesignMdSettings() {
  return (
    <InstructionsMdSettings
      fileName="DESIGN.md"
      title="UIデザイン（DESIGN.md）"
      endpoint="/api/design-md"
      placeholder={"# UIデザイン\n\n- 色・余白・タイポグラフィの規約\n- …"}
    />
  );
}
