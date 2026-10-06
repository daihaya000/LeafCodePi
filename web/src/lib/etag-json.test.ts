import { describe, expect, it } from "vitest";
import { etagJsonResponse, jsonEtag } from "./etag-json";

const request = (ifNoneMatch?: string) => new Request("http://localhost/api/tasks", {
  headers: ifNoneMatch ? { "if-none-match": ifNoneMatch } : {},
});

describe("etagJsonResponse", () => {
  const body = { tasks: [{ id: "t1", status: "idle" }] };

  it("returns the JSON body with a weak ETag", async () => {
    const response = etagJsonResponse(request(), body);
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe(jsonEtag(JSON.stringify(body)));
    expect(response.headers.get("etag")).toMatch(/^W\/"/);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual(body);
  });

  it("answers an unchanged body with an empty 304", async () => {
    const etag = etagJsonResponse(request(), body).headers.get("etag")!;
    for (const header of [etag, etag.replace(/^W\//, ""), `"other", ${etag}`]) {
      const response = etagJsonResponse(request(header), body);
      expect(response.status).toBe(304);
      expect(await response.text()).toBe("");
      expect(response.headers.get("etag")).toBe(etag);
    }
  });

  it("sends the new body when it changed, and tolerates a missing request", async () => {
    const etag = etagJsonResponse(request(), body).headers.get("etag")!;
    const changed = etagJsonResponse(request(etag), { tasks: [] });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toEqual({ tasks: [] });
    expect(etagJsonResponse(undefined, body).status).toBe(200);
  });

  it("never turns an error status into 304", () => {
    const etag = etagJsonResponse(request(), { error: "x" }).headers.get("etag")!;
    expect(etagJsonResponse(request(etag), { error: "x" }, { status: 503 }).status).toBe(503);
  });
});