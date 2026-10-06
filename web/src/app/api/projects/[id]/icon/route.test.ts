// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const store = vi.hoisted(() => ({ getProject: vi.fn() }));
vi.mock("@/lib/store", () => store);

import { GET } from "./route";
import { projectIconUrl, withProjectIconUrls } from "@/lib/project-icon-url";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const icon = `data:image/png;base64,${png.toString("base64")}`;
const call = (url: string, id = "p1") => GET(new NextRequest(url), { params: Promise.resolve({ id }) });

describe("project icons", () => {
  beforeEach(() => store.getProject.mockReset());

  it("lists a versioned URL instead of the data URL", () => {
    const [linked, plain, none] = withProjectIconUrls([
      { id: "p 1", icon },
      { id: "p2", icon: "https://example.test/x.png" },
      { id: "p3", icon: null },
    ] as never[]) as Array<{ icon: string | null }>;
    expect(linked!.icon).toBe(projectIconUrl("p 1", icon));
    expect(linked!.icon).toMatch(/^\/api\/projects\/p%201\/icon\?v=[\w-]{16}$/);
    expect(plain!.icon).toBe("https://example.test/x.png");
    expect(none!.icon).toBeNull();
    expect(projectIconUrl("p1", `${icon}A`)).not.toBe(projectIconUrl("p1", icon));
  });

  it("serves the bytes, immutable for the current version", async () => {
    store.getProject.mockReturnValue({ id: "p1", icon });
    const response = await call(`http://localhost${projectIconUrl("p1", icon)}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
  });

  it("does not cache a stale version and 404s without an image icon", async () => {
    store.getProject.mockReturnValue({ id: "p1", icon });
    const stale = await call("http://localhost/api/projects/p1/icon?v=old");
    expect(stale.status).toBe(200);
    expect(stale.headers.get("cache-control")).toBe("private, no-cache");
    store.getProject.mockReturnValue({ id: "p1", icon: null });
    expect((await call("http://localhost/api/projects/p1/icon")).status).toBe(404);
    store.getProject.mockReturnValue(undefined);
    expect((await call("http://localhost/api/projects/x/icon", "x")).status).toBe(404);
  });
});