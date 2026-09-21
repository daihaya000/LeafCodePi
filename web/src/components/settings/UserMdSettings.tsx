"use client";

import { InstructionsMdSettings } from "@/components/settings/InstructionsMdSettings";

export function UserMdSettings() {
  return (
    <InstructionsMdSettings
      fileName="USER.md"
      title="ユーザープロフィール（USER.md）"
      endpoint="/api/user-md"
      placeholder={"# ユーザープロフィール\n\n- 名前:\n- 好み:\n- …"}
    />
  );
}
