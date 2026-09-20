export type SkillGroupId = "n8n" | "slack";

export type SkillGroupDefinition = {
  id: SkillGroupId;
  label: string;
  description: string;
  skillNames: readonly string[];
};

/** Official skills that share one global Code/Bot switch in the UI. */
export const SKILL_GROUPS: readonly SkillGroupDefinition[] = [
  {
    id: "n8n",
    label: "n8n",
    description: "n8n公式Skillsをまとめて有効／無効にします。",
    skillNames: [
      "n8n-agents-official",
      "n8n-binary-and-data-official",
      "n8n-code-nodes-official",
      "n8n-credentials-and-security-official",
      "n8n-data-tables-official",
      "n8n-debugging-official",
      "n8n-error-handling-official",
      "n8n-expressions-official",
      "n8n-extending-mcp-official",
      "n8n-loops-official",
      "n8n-node-configuration-official",
      "n8n-subworkflows-official",
      "n8n-workflow-lifecycle-official",
      "using-n8n-skills-official",
    ],
  },
  {
    id: "slack",
    label: "Slack",
    description: "Slack公式Skillsをまとめて有効／無効にします。",
    skillNames: [
      "block-kit",
      "create-slack-app",
      "slack-api",
      "slack-cli",
      "slack-docs",
      "slack-messaging",
      "slack-search",
      "test-slack-app",
    ],
  },
];
