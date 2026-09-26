import { getSetting } from "@/lib/pi/web-settings";
import {
  PERMISSION_MODE_SETTING_KEY,
  parsePermissionMode,
  type PermissionMode,
} from "@/lib/permission-gate";
import {
  DEFAULT_SKILL_PERMISSION,
  SKILL_PERMISSION_SETTING_KEY,
  parseSkillPermission,
  type SkillPermission,
} from "@/lib/skill-permission";
import {
  SUBAGENT_PERMISSION_SETTING_KEY,
  parseSubagentPermission,
  type SubagentPermission,
} from "@/lib/subagent-permission";
import type { TaskSummary } from "@/lib/types";

/** Settings keys whose change must reach open Code sessions. */
export const CODE_PERMISSION_SETTING_KEYS: ReadonlySet<string> = new Set([
  PERMISSION_MODE_SETTING_KEY,
  SKILL_PERMISSION_SETTING_KEY,
  SUBAGENT_PERMISSION_SETTING_KEY,
]);

export function readCodePermissionMode(): PermissionMode {
  return parsePermissionMode(getSetting(PERMISSION_MODE_SETTING_KEY));
}

export function readCodeSkillPermission(): SkillPermission {
  return parseSkillPermission(getSetting(SKILL_PERMISSION_SETTING_KEY));
}

export function readCodeSubagentPermission(): SubagentPermission {
  return parseSubagentPermission(getSetting(SUBAGENT_PERMISSION_SETTING_KEY));
}

type CodePermissionTask = Pick<
  TaskSummary,
  "kind" | "botId" | "supervisorBotId" | "permissionMode" | "skillPermission"
>;

/**
 * Only user-started Code tasks follow the Settings approval mode. Bot-started or
 * Bot-supervised Code tasks keep the mode their Bot enforces (normally "ask").
 */
export function followsCodePermissionMode(
  task: Pick<TaskSummary, "kind" | "botId" | "supervisorBotId">,
): boolean {
  return task.kind !== "bot" && !task.botId && !task.supervisorBotId;
}

/**
 * Settings values a Code task has not applied yet. Unchanged values are omitted
 * so prompts do not rewrite the task record or permission file needlessly.
 */
export function codePermissionUpdates(task: CodePermissionTask): {
  permissionMode?: PermissionMode;
  skillPermission?: SkillPermission;
} {
  if (task.kind === "bot") return {};
  const updates: { permissionMode?: PermissionMode; skillPermission?: SkillPermission } = {};
  if (followsCodePermissionMode(task)) {
    const permissionMode = readCodePermissionMode();
    if (permissionMode !== task.permissionMode) updates.permissionMode = permissionMode;
  }
  const skillPermission = readCodeSkillPermission();
  // Tasks created before skill permissions were stored ran with skills allowed.
  if (skillPermission !== (task.skillPermission ?? DEFAULT_SKILL_PERMISSION)) {
    updates.skillPermission = skillPermission;
  }
  return updates;
}
