// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const store = vi.hoisted(() => ({ getProjectIcon: vi.fn() }));
vi.mock("@/lib/store", () => store);

import { openTaskFileStream } from "@backend-runtime/file-stream/task-files";
import { projectIconUrl, withProjectIconUrls } from "@/lib/project-icon-url";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1, 2, 3]);
const icon = `data:image/png;base64,${png.toString("base64")}`;
const call = (url: string, id = "p1") => openTaskFileStream({route:`projects/${encodeURIComponent(id)}/icon`,method:"GET",url,headers:{},authorized:true,signal:new AbortController().signal});

describe("project icons", () => {
  beforeEach(() => store.getProjectIcon.mockReset());

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
    store.getProjectIcon.mockReturnValue(icon);
    const response = await call(`http://localhost${projectIconUrl("p1", icon)}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
  });

  it("does not cache a stale version and 404s without an image icon", async () => {
    store.getProjectIcon.mockReturnValue(icon);
    const stale = await call("http://localhost/api/projects/p1/icon?v=old");
    expect(stale.status).toBe(200);
    expect(stale.headers.get("cache-control")).toBe("private, no-cache");
    await stale.body!.cancel();
    store.getProjectIcon.mockReturnValue(undefined);
    expect((await call("http://localhost/api/projects/p1/icon")).status).toBe(404);
    store.getProjectIcon.mockReturnValue(undefined);
    expect((await call("http://localhost/api/projects/x/icon", "x")).status).toBe(404);
  });
});