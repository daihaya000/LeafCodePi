const plain = (value) => value && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const unavailable = () => new Error("MCP generation lease unavailable");

/**
 * INTERNAL process-local generation fencing, not an OS/process lease or writer barrier.
 * Construction has no IO/callback calls. Caller supplies the actual synchronous process
 * authority. Invalidate BEFORE cooperative config writes/reloads, then begin a NEW
 * generation only when the owner's snapshot is ready. Old leases never revive, even
 * when config bytes/authority return to earlier values (cooperative ABA protection).
 * Captured leases share a generation; revoking one does not revoke its siblings.
 * Process-owner failure/reentrant checks revoke the whole generation. Disposal is final.
 * No config/credentials/network/session IO, counters/tokens returned, default owner,
 * ambient global/env discovery, cross-process exclusion or automatic activation.
 * Uncoordinated external writers still require separate fencing/barriers/revision checks.
 */
export function createBackendMcpGenerationOwner(options) {
  try {
    if (!plain(options) || !Object.hasOwn(options, "assertProcessOwner")
      || Object.keys(options).some((key) => key !== "assertProcessOwner")) throw unavailable();
    const assertProcessOwner = options.assertProcessOwner;
    if (typeof assertProcessOwner !== "function") throw unavailable();
    let sequence = 0n, active = false, disposed = false, checking = false;
    const invalidate = () => { sequence++; active = false; };
    const open = () => { if (disposed) throw unavailable(); };
    const verify = () => {
      if (checking) { invalidate(); throw unavailable(); }
      const expected = sequence;
      checking = true;
      try {
        const result = assertProcessOwner();
        if (result && typeof result.then === "function") {
          Promise.resolve(result).catch(() => undefined);
          throw unavailable();
        }
        if (result !== undefined || disposed || sequence !== expected) throw unavailable();
      } catch { invalidate(); throw unavailable(); }
      finally { checking = false; }
    };
    const lease = (generation) => {
      let revoked = false;
      const current = () => { if (revoked || disposed || !active || sequence !== generation) throw unavailable(); };
      return Object.freeze({
        assertOwner: () => {
          try { current(); verify(); current(); }
          catch { revoked = true; throw unavailable(); }
        },
        revoke: () => { revoked = true; },
      });
    };
    return Object.freeze({
      beginGeneration: () => {
        try { open(); invalidate(); verify(); active = true; return lease(sequence); }
        catch { throw unavailable(); }
      },
      captureLease: () => {
        try { open(); if (!active) throw unavailable(); verify(); return lease(sequence); }
        catch { throw unavailable(); }
      },
      invalidate: () => { if (!disposed) invalidate(); },
      dispose: () => { if (!disposed) { disposed = true; invalidate(); } },
    });
  } catch { throw unavailable(); }
}
