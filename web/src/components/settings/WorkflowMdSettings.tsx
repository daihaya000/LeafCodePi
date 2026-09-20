"use client";

import { InstructionsMdSettings } from "@/components/settings/InstructionsMdSettings";

export function WorkflowMdSettings() {
  return (
    <InstructionsMdSettings
      fileName="WORKFLOW.md"
      title="作業手順（WORKFLOW.md）"
      endpoint="/api/workflow-md"
      description={
        <>
          Git操作・検証・コミットの詳細手順です。Code は常時読み込まず、変更作業・検証・Git操作の前に <span className="font-mono">read</span> で読み込みます。保存した内容は次の読み込みから有効です。
        </>
      }
      placeholder={"# 作業手順\n\n- 変更前の状態確認\n- 検証・差分確認・コミット\n"}
    />
  );
}
