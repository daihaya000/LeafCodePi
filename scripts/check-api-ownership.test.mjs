import assert from "node:assert/strict";
import test from "node:test";
import { check, exportedMethods, ownershipTable, validateInventory } from "./check-api-ownership.mjs";

function fixture() {
  return {
    inventory: {
      version: 1,
      groups: { runtime: {} },
      routes: [{
        route: "/api/tasks",
        source: "web/src/app/api/tasks/route.ts",
        group: "runtime",
        operations: [{ method: "GET", owner: "Backend", phase: 3, decision: "thin-backend-relay", contract: "json", note: "Backend owns task state" }],
      }],
    },
    actual: new Map([["/api/tasks", { source: "web/src/app/api/tasks/route.ts", methods: ["GET"] }]]),
  };
}

test("AST extracts actual HTTP exports, not helpers, comments or type exports", () => {
  assert.deepEqual(exportedMethods(`
    // export async function DELETE() {}
    export const runtime = "nodejs";
    function POST() {}
    export default function DELETE() {}
    export async function GET() {}
    export const PATCH = () => {};
    const handle = () => {};
    export { handle as HEAD };
    export type { OPTIONS } from "./types";
  `), ["GET", "HEAD", "PATCH"]);
});

test("rejects unsupported wildcard route exports and invalid syntax", () => {
  assert.throws(() => exportedMethods('export * from "./handlers";'), /wildcard route exports/);
  assert.throws(() => exportedMethods("export function GET("), /syntax errors/);
});

test("every checked-in API operation has an owner and the Markdown table matches", () => {
  const result = check();
  assert.ok(result.routes > 0);
  assert.ok(result.operations >= result.routes);
});

test("accepts complete ownership and renders method-level decisions", () => {
  const { inventory, actual } = fixture();
  assert.deepEqual(validateInventory(inventory, actual), { routes: 1, operations: 1 });
  assert.ok(ownershipTable(inventory).includes("GET → Backend / Phase3"));
});

test("rejects a missing route", () => {
  const { inventory, actual } = fixture();
  actual.set("/api/new", { source: "web/src/app/api/new/route.ts", methods: ["POST"] });
  assert.throws(() => validateInventory(inventory, actual), /route coverage mismatch/);
});

test("rejects unknown and duplicate routes", () => {
  const { inventory, actual } = fixture();
  inventory.routes.push(structuredClone(inventory.routes[0]));
  assert.throws(() => validateInventory(inventory, actual), /duplicate route/);
  inventory.routes.pop();
  inventory.routes[0].route = "/api/removed";
  assert.throws(() => validateInventory(inventory, actual), /unknown route/);
});

test("rejects changed and duplicate HTTP methods", () => {
  const { inventory, actual } = fixture();
  inventory.routes[0].operations[0].method = "POST";
  assert.throws(() => validateInventory(inventory, actual), /method mismatch/);
  inventory.routes[0].operations[0].method = "GET";
  inventory.routes[0].operations.push(structuredClone(inventory.routes[0].operations[0]));
  assert.throws(() => validateInventory(inventory, actual), /method mismatch/);
});

test("rejects unowned operations and missing rationale", () => {
  const { inventory, actual } = fixture();
  const operation = inventory.routes[0].operations[0];
  operation.owner = "pending";
  assert.throws(() => validateInventory(inventory, actual), /invalid owner/);
  operation.owner = "Backend";
  operation.decision = "retain-edge";
  assert.throws(() => validateInventory(inventory, actual), /owner\/decision mismatch/);
  operation.decision = "thin-backend-relay";
  operation.note = "";
  assert.throws(() => validateInventory(inventory, actual), /missing rationale/);
});

test("rejects invalid phase, contract, group and source", () => {
  for (const [field, value, error] of [["phase", 6, /invalid phase/], ["contract", "unknown", /invalid contract/]]) {
    const { inventory, actual } = fixture();
    inventory.routes[0].operations[0][field] = value;
    assert.throws(() => validateInventory(inventory, actual), error);
  }
  const { inventory, actual } = fixture();
  inventory.routes[0].group = "unknown";
  assert.throws(() => validateInventory(inventory, actual), /unknown group/);
  inventory.routes[0].group = "runtime";
  inventory.routes[0].source = "web/src/app/api/other/route.ts";
  assert.throws(() => validateInventory(inventory, actual), /source mismatch/);
});
