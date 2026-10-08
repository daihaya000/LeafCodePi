import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import * as owner from "./pi/harness";
/** Guard before hydration, task store writes, cold Goal commands or Bot outbox/session teardown. */
export function getTaskDetail(...args: Parameters<typeof owner.getTaskDetail>) { assertConfigurationOwner(); return owner.getTaskDetail(...args); }
export function archiveTask(...args: Parameters<typeof owner.archiveTask>) { assertConfigurationOwner(); return owner.archiveTask(...args); }
export function restoreTask(...args: Parameters<typeof owner.restoreTask>) { assertConfigurationOwner(); return owner.restoreTask(...args); }
export function destroyTask(...args: Parameters<typeof owner.destroyTask>) { assertConfigurationOwner(); return owner.destroyTask(...args); }
export function abortTaskIncludingColdGoalLoop(...args: Parameters<typeof owner.abortTaskIncludingColdGoalLoop>) { assertConfigurationOwner(); return owner.abortTaskIncludingColdGoalLoop(...args); }
export function stopBotCodeTask(...args: Parameters<typeof owner.stopBotCodeTask>) { assertConfigurationOwner(); return owner.stopBotCodeTask(...args); }
