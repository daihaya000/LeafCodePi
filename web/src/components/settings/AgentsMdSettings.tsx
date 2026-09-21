"use client";

import { InstructionsMdSettings } from "@/components/settings/InstructionsMdSettings";

export function AgentsMdSettings() {
  return (
    <InstructionsMdSettings
      fileName="AGENTS.md"
      title="カスタム指示（AGENTS.md）"
      endpoint="/api/agents-md"
      placeholder={"# カスタム指示\n\n- 簡潔に答える\n- …"}
    />
  );
}
