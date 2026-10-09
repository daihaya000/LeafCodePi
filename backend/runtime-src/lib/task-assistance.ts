import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import * as harness from "./pi/harness";
import * as store from "./store";
import * as titles from "./direct-title";
/** API entrances reject Next before session, settings, pending FIFO, persistence or generation. */
export function readTaskProgressSnapshot(...args: Parameters<typeof harness.readTaskProgressSnapshot>) { assertConfigurationOwner(); return harness.readTaskProgressSnapshot(...args); }
export function pendingPermissionForTask(...args: Parameters<typeof harness.pendingPermissionForTask>) { assertConfigurationOwner(); return harness.pendingPermissionForTask(...args); }
export function getTask(...args: Parameters<typeof store.getTask>) { assertConfigurationOwner(); return store.getTask(...args); }
export function patchTask(...args: Parameters<typeof store.patchTask>) { assertConfigurationOwner(); return store.patchTask(...args); }
export function refreshTaskTitleDirect(...args: Parameters<typeof titles.refreshTaskTitleDirect>) { assertConfigurationOwner(); return titles.refreshTaskTitleDirect(...args); }
export function refreshTaskLabelDirect(...args: Parameters<typeof titles.refreshTaskLabelDirect>) { assertConfigurationOwner(); return titles.refreshTaskLabelDirect(...args); }
