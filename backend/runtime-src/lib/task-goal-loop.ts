import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import * as owner from "./pi/harness";
/** Guard the public runtime entry before session creation, commands, filesystem/cache or live inventory reads. */
export function goalLoopState(...args:Parameters<typeof owner.goalLoopState>) {
  assertConfigurationOwner(); return owner.goalLoopState(...args);
}
export function goalLoopCommand(...args:Parameters<typeof owner.goalLoopCommand>) {
  assertConfigurationOwner(); return owner.goalLoopCommand(...args);
}
export function activeGoalLoopTaskIds() {
  assertConfigurationOwner(); return owner.activeGoalLoopTaskIds();
}
