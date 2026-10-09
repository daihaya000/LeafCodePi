import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import * as owner from "./pi/harness";
/** Guard before session abort/disposal, workspace copy or store mutation, not after the effects. */
export function addProject(...args: Parameters<typeof owner.addProject>) { assertConfigurationOwner(); return owner.addProject(...args); }
export function patchProject(...args: Parameters<typeof owner.patchProject>) { assertConfigurationOwner(); return owner.patchProject(...args); }
export function restoreProject(...args: Parameters<typeof owner.restoreProject>) { assertConfigurationOwner(); return owner.restoreProject(...args); }
export function archiveProjectAndStopTasks(...args: Parameters<typeof owner.archiveProjectAndStopTasks>) { assertConfigurationOwner(); return owner.archiveProjectAndStopTasks(...args); }
export function migrateProject(...args: Parameters<typeof owner.migrateProject>) { assertConfigurationOwner(); return owner.migrateProject(...args); }
export function destroyProject(...args: Parameters<typeof owner.destroyProject>) { assertConfigurationOwner(); return owner.destroyProject(...args); }
