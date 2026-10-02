const plain = (value) => value && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const unavailable = () => new Error("MCP credential store unavailable");
const keys = ["assertOwner", "readState", "writeState", "removeState", "withRefreshLock"];

function synchronous(value) {
  if (value && typeof value.then === "function") {
    // Reject unsupported async storage without leaking an unhandled private rejection.
    Promise.resolve(value).catch(() => undefined);
    throw unavailable();
  }
  return value;
}
function identity(name, serverUrl) {
  if (typeof name !== "string" || !/^[A-Za-z0-9_-]+$/.test(name)
    || typeof serverUrl !== "string" || /[\x00-\x20\x7f]/.test(serverUrl)) throw unavailable();
  const url = new URL(serverUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw unavailable();
  // Pi's namespace aliases are one identity; different names sharing a URL are not.
  return Object.freeze({ namespace: `mcp__${name.replaceAll("-", "_")}`, serverUrl: url.href });
}
function cloneState(value, ownerIdentity) {
  if (value === undefined) return undefined;
  if (!plain(value)) throw unavailable();
  // Validate the detached snapshot, not a getter's earlier value.
  const copy = structuredClone(value);
  if (!Object.hasOwn(copy, "serverUrl") || copy.serverUrl !== ownerIdentity.serverUrl) throw unavailable();
  if (Object.hasOwn(copy, "tokens") && copy.tokens !== undefined) {
    const tokens = copy.tokens;
    if (!plain(tokens) || !["access_token", "token_type"].every((key) => Object.hasOwn(tokens, key)
      && typeof tokens[key] === "string" && tokens[key].length > 0 && !/[\x00-\x1f\x7f]/.test(tokens[key]))) throw unavailable();
  }
  return copy;
}

/**
 * INTERNAL, structural compatibility with the PUBLIC methods of SDK MCP credentials.
 * The SDK's concrete class has private fields and no public constructor export;
 * this adapter neither imports it nor pretends to be an instance of it.
 * No default storage, migration, legacy URL-only takeover, browser or network IO.
 * Owner services must provide synchronous state IO and a cross-process refresh
 * lock. Every operation rechecks ownership. State/PKCE/client metadata is private;
 * never return this object or its loaded values to Web/API callers.
 * SDK work errors retain their identity (OAuth-required routing depends on it).
 * Owner/storage errors are sanitized. Failures do not imply a write was rolled back.
 */
export function createBackendMcpCredentials(options) {
  try {
    if (!plain(options) || Object.keys(options).some((key) => !keys.includes(key))
      || !keys.every((key) => Object.hasOwn(options, key))) throw unavailable();
    const owner = Object.fromEntries(keys.map((key) => [key, options[key]]));
    if (!keys.every((key) => typeof owner[key] === "function")) throw unavailable();
    const checkOwner = (id) => {
      if (synchronous(owner.assertOwner(id)) !== undefined) throw unavailable();
    };
    const call = (id, operation, ...args) => {
      try { checkOwner(id); return synchronous(owner[operation](id, ...args)); }
      catch { throw unavailable(); }
    };
    const load = (id) => {
      try { return cloneState(call(id, "readState"), id); }
      catch { throw unavailable(); }
    };
    const forServer = (name, serverUrl) => {
      let id;
      try { id = identity(name, serverUrl); checkOwner(id); }
      catch { throw unavailable(); }
      return Object.freeze({
        load: () => load(id),
        save: (state) => {
          try {
            checkOwner(id);
            const copy = cloneState(state, id);
            if (!copy || call(id, "writeState", copy) !== undefined) throw unavailable();
          } catch { throw unavailable(); }
        },
        withRefreshLock: async (fn) => {
          let workFailed = false, workError, entered = false, active = true, finished = false;
          try {
            checkOwner(id);
            if (typeof fn !== "function") throw unavailable();
            const result = await owner.withRefreshLock(id, async () => {
              if (!active || entered) throw unavailable();
              entered = true;
              checkOwner(id);
              try { return await fn(); }
              catch (error) { workFailed = true; workError = error; throw error; }
              finally { finished = true; }
            });
            if (workFailed) throw workError;
            if (!entered || !finished) throw unavailable();
            return result;
          } catch (error) {
            if (workFailed && error === workError) throw error;
            throw unavailable();
          } finally { active = false; }
        },
      });
    };
    return Object.freeze({
      forServer,
      tokens: (name, serverUrl) => {
        try { const state = load(identity(name, serverUrl)); return state && Object.hasOwn(state, "tokens") ? state.tokens : undefined; }
        catch { throw unavailable(); }
      },
      remove: (name, serverUrl) => {
        try {
          const result = call(identity(name, serverUrl), "removeState");
          if (typeof result !== "boolean") throw unavailable();
          return result;
        } catch { throw unavailable(); }
      },
    });
  } catch { throw unavailable(); }
}
