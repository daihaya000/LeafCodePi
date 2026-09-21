"use client";

import { InstructionsMdSettings } from "@/components/settings/InstructionsMdSettings";

export function WorkflowMdSettings() {
  return (
    <InstructionsMdSettings
      fileName="WORKFLOW.md"
      title="作業手順（WORKFLOW.md）"
      endpoint="/api/workflow-md"
      placeholder={"# 作業手順\n\n- 変更前の状態確認\n- 検証・差分確認・コミット\n"}
    />
  );
}
