"use client";

import { InstructionsMdSettings } from "@/components/settings/InstructionsMdSettings";

export function AgentsMdSettings() {
  return (
    <InstructionsMdSettings
      fileName="AGENTS.md"
      title="カスタム指示（AGENTS.md）"
      endpoint="/api/agents-md"
      description={
        <>
          全プロジェクト共通の指示です。Pi は <span className="font-mono">~/.pi/agent/AGENTS.md</span>{" "}
          を読み込みます。保存すると開いているセッションにも即時反映され（進行中の応答の次のターンから）。
        </>
      }
      placeholder={"# カスタム指示\n\n- 簡潔に答える\n- …"}
    />
  );
}
