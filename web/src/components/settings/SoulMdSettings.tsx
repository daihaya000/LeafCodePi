"use client";

import { InstructionsMdSettings } from "@/components/settings/InstructionsMdSettings";

export function SoulMdSettings() {
  return (
    <InstructionsMdSettings
      fileName="SOUL.md"
      title="性格・口調（SOUL.md）"
      endpoint="/api/soul-md"
      placeholder={"# 性格・口調\n\n- 簡潔で丁寧に答える\n- …"}
    />
  );
}
