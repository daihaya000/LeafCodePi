import { expect, it } from "vitest";
import { beginTaskPreparation, hasTaskPreparation, invalidateTaskPreparations, withTaskSessionMutation, withTaskTreeEdit } from "./task-operation-guard";
it("a stop cancels every older preparation but a fresh send remains allowed", () => {
  const a = beginTaskPreparation("cancel"); const b = beginTaskPreparation("cancel");
  invalidateTaskPreparations("cancel");
  const fresh = beginTaskPreparation("cancel");
  try {
    expect(() => a.assertCurrent()).toThrow(); expect(() => b.assertCurrent()).toThrow();
    fresh.assertCurrent();
  } finally { a.release(); b.release(); fresh.release(); }
  expect(hasTaskPreparation("cancel")).toBe(false);
});
it("a pending selection blocks tree navigation, and repeated release cannot drop another token", async () => {
  const first = beginTaskPreparation("selection"); const second = beginTaskPreparation("selection");
  first.release(); first.release();
  try { await expect(withTaskTreeEdit("selection", async () => 1)).rejects.toMatchObject({ status: 409 }); }
  finally { second.release(); }
  expect(await withTaskTreeEdit("selection", async () => 42)).toBe(42);
});
it("a cancelled read-only selection frees the tree gate before its provider completes", async () => {
  const token = beginTaskPreparation("slow-provider");
  let complete!: (value: number) => void;
  const provider = new Promise<number>((resolve) => { complete = resolve; });
  const selection = token.waitFor(provider).finally(() => token.release());
  invalidateTaskPreparations("slow-provider");
  await expect(selection).rejects.toMatchObject({ status: 409 });
  expect(await withTaskTreeEdit("slow-provider", async () => 42)).toBe(42);
  complete(1);
});
it("an in-flight session mutation holds the tree gate even after a stop", async () => {
  let complete!: () => void;
  const gate = new Promise<void>((resolve) => { complete = resolve; });
  const mutation = withTaskSessionMutation("mutator", async () => { await gate; return 42; });
  invalidateTaskPreparations("mutator");
  try { await expect(withTaskTreeEdit("mutator", async () => 1)).rejects.toMatchObject({ status: 409 }); }
  finally { complete(); await mutation; }
  expect(await withTaskTreeEdit("mutator", async () => 42)).toBe(42);
});
it("a failed edit releases the gate without blocking another task", async () => {
  await expect(withTaskTreeEdit("failed", async () => { throw new Error("navigation failed"); })).rejects.toThrow("navigation failed");
  expect(await withTaskTreeEdit("failed", async () => 42)).toBe(42);
  expect(await withTaskTreeEdit("failed", async () => {
    const unrelated = beginTaskPreparation("another"); unrelated.release();
    expect(() => beginTaskPreparation("failed")).toThrow();
    return 42;
  })).toBe(42);
});
