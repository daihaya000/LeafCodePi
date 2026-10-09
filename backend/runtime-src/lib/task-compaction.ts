import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import * as owner from "./pi/harness";
/** Reject Next before loading a cold session, touching caches/files or invoking a summarizer/abort. */
export function compactTask(...args: Parameters<typeof owner.compactTask>) {
  assertConfigurationOwner(); return owner.compactTask(...args);
}
export function abortTaskCompaction(...args: Parameters<typeof owner.abortTaskCompaction>) {
  assertConfigurationOwner(); return owner.abortTaskCompaction(...args);
}
