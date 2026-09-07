"use client";

import { InstructionsMdSettings } from "@/components/settings/InstructionsMdSettings";

export function BotsMdSettings() {
  return (
    <InstructionsMdSettings
      fileName="BOTS.md"
      title="共通指示（BOTS.md）"
      endpoint="/api/bots-md"
      description={
        <>
          全ボット共通の指示です。ボットは <span className="font-mono">~/.pi/agent/BOTS.md</span> と各ボットの{" "}
          <span className="font-mono">SOUL.md</span> を読み込みます（AGENTS.md は読み込みません）。保存すると開いているボットにも次のターンから反映されます。
        </>
      }
      placeholder={"# ボット共通指示\n\n- 日本語で簡潔に答える\n- …"}
    />
  );
}
