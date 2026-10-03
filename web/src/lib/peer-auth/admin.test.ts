import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPeerGrantStore } from "@backend-core/peer-auth-grants.mjs";
import { createPeerAdmin } from "./admin";

const dirs: string[] = [];
function setup(authRequired = true) {
  const dir = mkdtempSync(join(tmpdir(), "leafcode-peer-admin-"));
  dirs.push(dir);
  const store = createPeerGrantStore({ path: join(dir, "peer-auth.json") });
  return { store, admin: createPeerAdmin({ store, authRequired: () => authRequired }) };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("createPeerAdmin", () => {
  it("creates a grant, returns the token once, and never lists it or its hash", () => {
    const { admin } = setup();
    const created = admin.create({ label: "laptop", providers: ["anthropic"] });
    expect(created.status).toBe(201);
    const { grant, token } = created.body as { grant: { id: string }; token: string };
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const listed = JSON.stringify(admin.get().body);
    expect(listed).toContain(grant.id);
    expect(listed).not.toContain(token);
    expect(listed).not.toContain("tokenSha256");
  });

  it("rejects unknown fields and invalid input with 400 and the store's message", () => {
    const { admin, store } = setup();
    expect(admin.create(null).status).toBe(400);
    expect(admin.create({ label: "x", providers: ["a"], tokenSha256: "x" }).status).toBe(400);
    const bad = admin.create({ label: "", providers: ["a"] });
    expect(bad).toEqual({ status: 400, body: { error: "label is invalid" } });
    expect(store.list()).toEqual([]);
  });

  it("refuses to enable sharing unless WebUI authentication is required, but always allows disabling", () => {
    const open = setup(false);
    expect(open.admin.setEnabled({ enabled: true }).status).toBe(409);
    expect(open.store.isEnabled()).toBe(false);
    open.store.setEnabled(true);
    expect(open.admin.setEnabled({ enabled: false }).status).toBe(200);
    expect(open.store.isEnabled()).toBe(false);

    const protectedUi = setup(true);
    const enabled = protectedUi.admin.setEnabled({ enabled: true });
    expect(enabled.status).toBe(200);
    expect(enabled.body).toMatchObject({ enabled: true, authRequired: true });
  });

  it("validates the enable request shape", () => {
    const { admin } = setup();
    for (const body of [null, {}, { enabled: "yes" }, { enabled: true, extra: 1 }]) {
      expect(admin.setEnabled(body).status).toBe(400);
    }
  });

  it("revokes by id: 400 without id, 404 for unknown, 200 and the token stops verifying", () => {
    const { admin, store } = setup();
    store.setEnabled(true);
    const { grant, token } = (admin.create({ label: "a", providers: ["a"] }).body as { grant: { id: string }; token: string });
    expect(admin.revoke(null).status).toBe(400);
    expect(admin.revoke("missing").status).toBe(404);
    expect(store.verify(token)).not.toBeNull();
    expect(admin.revoke(grant.id).status).toBe(200);
    expect(store.verify(token)).toBeNull();
  });

  it("keeps unexpected errors opaque", () => {
    const admin = createPeerAdmin({
      store: { isEnabled: () => { throw new Error("EACCES: /secret/path"); } } as never,
      authRequired: () => true,
    });
    expect(admin.get()).toEqual({ status: 500, body: { error: "internal error" } });
  });
});
