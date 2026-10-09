import { AsyncLocalStorage } from "node:async_hooks";
import { assertConfigurationOwner } from "./configuration-command.mjs";
// Bundle and Node entry share the private scope, not two module-local effect observers.
const key = Symbol.for("leafcode.backend.mcp-business-effects");
const scope = globalThis[key] ??= new AsyncLocalStorage();
export function markMcpBusinessEffect() { assertConfigurationOwner(); const state = scope.getStore(); if (state) state.started = true; }
export function withMcpBusinessEffects(work) { assertConfigurationOwner(); return scope.run({ started: false }, () => work(() => scope.getStore().started)); }
