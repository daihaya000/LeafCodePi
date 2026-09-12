"use client";

import { InstructionsMdSettings } from "@/components/settings/InstructionsMdSettings";

export function SoulMdSettings() {
  return (
    <InstructionsMdSettings
      fileName="SOUL.md"
      title="性格・口調（SOUL.md）"
      endpoint="/api/soul-md"
      description={
        <>
          Code専用の性格・口調です。Code は <span className="font-mono">~/.pi/agent/SOUL.md</span>{" "}
          を読み込みます（ボットは各ボットの <span className="font-mono">SOUL.md</span> を使うため読み込みません）。保存すると開いているセッションにも即時反映され（進行中の応答の次のターンから）。
        </>
      }
      placeholder={"# 性格・口調\n\n- 簡潔で丁寧に答える\n- …"}
    />
  );
}
