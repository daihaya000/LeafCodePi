import type { PeerGrant, PeerGrantStore } from "@backend-core/peer-auth-grants.mjs";

export type PeerAdminResult = { status: number; body: unknown };

type Deps = {
  store: PeerGrantStore;
  /** Whether the WebUI itself demands a token (remote exposure is protected). */
  authRequired: () => boolean;
};

const plain = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const fail = (status: number, error: string): PeerAdminResult => ({ status, body: { error } });

function guard(action: () => PeerAdminResult): PeerAdminResult {
  try {
    return action();
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    // Store validation errors are user-safe; anything else stays opaque.
    if (status === 400 && error instanceof Error) return fail(400, error.message);
    return fail(500, "internal error");
  }
}

/** Management of peer grants for the WebUI-authenticated settings UI. Tokens are shown once, at creation. */
export function createPeerAdmin({ store, authRequired }: Deps) {
  const snapshot = (): { enabled: boolean; authRequired: boolean; grants: PeerGrant[] } => ({
    enabled: store.isEnabled(), authRequired: authRequired(), grants: store.list(),
  });

  return {
    get: (): PeerAdminResult => guard(() => ({ status: 200, body: snapshot() })),

    create: (body: unknown): PeerAdminResult => guard(() => {
      if (!plain(body) || Object.keys(body).some((key) => !["label", "accountId", "providers"].includes(key))) {
        return fail(400, "invalid request");
      }
      const { grant, token } = store.create({
        label: body.label as string,
        accountId: body.accountId === undefined ? null : (body.accountId as string | null),
        providers: body.providers as string[],
      });
      return { status: 201, body: { grant, token } };
    }),

    /** Enabling sharing needs a protected WebUI; disabling is always allowed. */
    setEnabled: (body: unknown): PeerAdminResult => guard(() => {
      if (!plain(body) || Object.keys(body).length !== 1 || typeof body.enabled !== "boolean") return fail(400, "invalid request");
      if (body.enabled && !authRequired()) return fail(409, "WebUI authentication must be required before sharing is enabled");
      store.setEnabled(body.enabled);
      return { status: 200, body: snapshot() };
    }),

    revoke: (id: string | null): PeerAdminResult => guard(() => {
      if (!id) return fail(400, "id is required");
      return store.revoke(id) ? { status: 200, body: snapshot() } : fail(404, "grant not found");
    }),
  };
}
