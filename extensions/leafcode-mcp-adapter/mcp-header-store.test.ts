import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";
import {
  getMcpHeadersForUrl,
  inspectMcpHeadersForUrl,
  removeMcpHeaders,
  saveMcpHeadersForUrl,
} from "./mcp-header-store.ts";

describe("mcp-header-store", () => {
  const serverName = "header-store-test";
  const serverUrl = "https://headers.example.com/mcp";
  const previousStore = process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE;

  afterEach(() => {
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "memory";
    removeMcpHeaders(serverName);
    if (previousStore === undefined) delete process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE;
    else process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = previousStore;
  });

  it("stores headers with URL binding and never treats another URL as valid", () => {
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "memory";
    saveMcpHeadersForUrl(serverName, { "X-API-Key": "secret-value" }, serverUrl);

    assert.deepEqual(getMcpHeadersForUrl(serverName, serverUrl), { "X-API-Key": "secret-value" });
    assert.equal(inspectMcpHeadersForUrl(serverName, serverUrl).status, "present");
    assert.equal(getMcpHeadersForUrl(serverName, "https://other.example.com/mcp"), undefined);
    assert.equal(inspectMcpHeadersForUrl(serverName, "https://other.example.com/mcp").status, "url-mismatch");
  });
});
