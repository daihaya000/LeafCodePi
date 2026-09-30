// Compatibility entrypoint: session identity reconciliation lives in backend core
// so the Backend process can project session metadata onto tasks.
export {
  sessionIdentityPatch,
  type SessionIdentity,
  type SessionIdentityPatch,
} from "@backend-core/session-identity.mjs";
