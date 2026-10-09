import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import * as owner from "./pi/harness";
import { forkTask as ownerForkTask } from "./pi/task-fork";
/** Public entrances reject Next before cache, SDK, session-tree, workspace or pending-attention effects. */
export function forkTask(...args: Parameters<typeof ownerForkTask>) {
  assertConfigurationOwner(); return ownerForkTask(...args);
}
export function revertTask(...args: Parameters<typeof owner.revertTask>) {
  assertConfigurationOwner(); return owner.revertTask(...args);
}
export function unrevertTask(...args: Parameters<typeof owner.unrevertTask>) {
  assertConfigurationOwner(); return owner.unrevertTask(...args);
}
export function promoteTask(...args: Parameters<typeof owner.promoteTask>) {
  assertConfigurationOwner(); return owner.promoteTask(...args);
}
