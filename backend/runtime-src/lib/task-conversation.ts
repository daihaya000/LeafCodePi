import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import * as owner from "./pi/harness";
/** Guard the public runtime entry before touching process-local SDK services or a session. */
export function promptTask(...args: Parameters<typeof owner.promptTask>) {
  assertConfigurationOwner(); return owner.promptTask(...args);
}
export function respondToPermissionPrompt(...args: Parameters<typeof owner.respondToPermissionPrompt>) {
  assertConfigurationOwner(); return owner.respondToPermissionPrompt(...args);
}
export function respondToQuestionPrompt(...args: Parameters<typeof owner.respondToQuestionPrompt>) {
  assertConfigurationOwner(); return owner.respondToQuestionPrompt(...args);
}
