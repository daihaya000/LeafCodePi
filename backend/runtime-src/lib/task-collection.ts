import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import * as owner from "./pi/harness";
/** Before model selection/generation, session creation, maintenance or bulk teardown effects. */
export function createTask(...args: Parameters<typeof owner.createTask>) { assertConfigurationOwner(); return owner.createTask(...args); }
export function destroyArchivedTasksByProject(...args: Parameters<typeof owner.destroyArchivedTasksByProject>) { assertConfigurationOwner(); return owner.destroyArchivedTasksByProject(...args); }
export function autoArchiveOldTasks(...args: Parameters<typeof owner.autoArchiveOldTasks>) { assertConfigurationOwner(); return owner.autoArchiveOldTasks(...args); }
export function getTaskSummariesWithTodoProgress(...args: Parameters<typeof owner.getTaskSummariesWithTodoProgress>) { assertConfigurationOwner(); return owner.getTaskSummariesWithTodoProgress(...args); }
export function resolveAutoModel(...args: Parameters<typeof owner.resolveAutoModel>) { assertConfigurationOwner(); return owner.resolveAutoModel(...args); }
export function validateTaskModelSelection(...args: Parameters<typeof owner.validateTaskModelSelection>) { assertConfigurationOwner(); return owner.validateTaskModelSelection(...args); }
export function listPendingAttention(...args: Parameters<typeof owner.listPendingAttention>) { assertConfigurationOwner(); return owner.listPendingAttention(...args); }
