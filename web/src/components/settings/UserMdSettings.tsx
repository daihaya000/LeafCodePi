"use client";

import { InstructionsMdSettings } from "@/components/settings/InstructionsMdSettings";

export function UserMdSettings() {
  return (
    <InstructionsMdSettings
      fileName="USER.md"
      title="ユーザープロフィール（USER.md）"
      endpoint="/api/user-md"
      description={
        <>
          全プロジェクト共通のユーザー情報です。Code は <span className="font-mono">~/.pi/agent/USER.md</span>{" "}
          を読み込みます。保存すると開いているセッションにも即時反映され（進行中の応答の次のターンから）。
        </>
      }
      placeholder={"# ユーザープロフィール\n\n- 名前:\n- 好み:\n- …"}
    />
  );
}
