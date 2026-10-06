import { NextRequest, NextResponse } from "next/server";
import { etagJsonResponse } from "@/lib/etag-json";
import { withProjectIconUrls } from "@/lib/project-icon-url";
import {
  addProject,
  archiveProjectAndStopTasks,
  destroyProject,
  getProjects,
  jsonError,
  migrateProject,
  patchProject,
  restoreProject,
} from "@/lib/pi/harness";
import { PROJECT_ICON_COLORS, type ProjectIconColor } from "@/lib/types";
import { forwardProjectTeardown } from "@/lib/backend-forward";
import { localRuntimeBlocked } from "@/lib/pi/runtime-ownership";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Archiving, deleting or moving a project stops its running sessions, which only the owning Backend
 * holds. The owner's own status and body are replayed; a Backend that cannot answer is a 502.
 */
async function teardownOnBackend(
  id: string,
  request: { action: "archive" | "destroy" | "migrate"; destinationPath?: string },
): Promise<NextResponse> {
  const forwarded = await forwardProjectTeardown(id, request);
  if (!forwarded.ok) {
    return NextResponse.json(
      { error: "Backendで実行できません", code: "BACKEND_FORWARD_FAILED", reason: forwarded.reason },
      { status: 502 },
    );
  }
  return NextResponse.json(forwarded.body, { status: forwarded.status });
}

export async function GET(req: NextRequest) {
  const includeArchived = req.nextUrl.searchParams.get("archived") === "1";
  return etagJsonResponse(req, { projects: withProjectIconUrls(getProjects(includeArchived)) });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as { rootPath?: string } | null;
    if (!body?.rootPath) {
      return NextResponse.json({ error: "rootPath is required" }, { status: 400 });
    }
    const project = addProject(body.rootPath);
    return NextResponse.json({ project });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as {
      id?: string;
      archived?: boolean;
      icon?: unknown;
      iconColor?: unknown;
      destinationPath?: unknown;
    } | null;
    if (!body?.id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }
    if (body.archived === true) {
      if (localRuntimeBlocked()) return await teardownOnBackend(body.id, { action: "archive" });
      return NextResponse.json({ project: await archiveProjectAndStopTasks(body.id) });
    }
    if (body.archived === false) {
      return NextResponse.json({ project: restoreProject(body.id) });
    }
    if (body.destinationPath !== undefined) {
      if (typeof body.destinationPath !== "string" || !body.destinationPath.trim()) {
        return NextResponse.json({ error: "destinationPath が必要です" }, { status: 400 });
      }
      if (localRuntimeBlocked()) {
        return await teardownOnBackend(body.id, { action: "migrate", destinationPath: body.destinationPath });
      }
      return NextResponse.json(await migrateProject(body.id, body.destinationPath));
    }
    if (typeof body.icon === "string" || body.icon === null) {
      if (typeof body.icon === "string" && (!/^data:image\/(png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/=]+$/.test(body.icon) || body.icon.length > 3_000_000)) {
        return NextResponse.json({ error: "icon must be a valid image under 2 MB" }, { status: 400 });
      }
      const project = patchProject(body.id, { icon: body.icon });
      if (!project) return NextResponse.json({ error: "プロジェクトが見つかりません" }, { status: 404 });
      return NextResponse.json({ project });
    }
    if (
      body.iconColor === null ||
      (typeof body.iconColor === "string" && PROJECT_ICON_COLORS.includes(body.iconColor as ProjectIconColor))
    ) {
      const project = patchProject(body.id, { iconColor: body.iconColor as ProjectIconColor | null });
      if (!project) return NextResponse.json({ error: "プロジェクトが見つかりません" }, { status: 404 });
      return NextResponse.json({ project });
    }
    return NextResponse.json({ error: "unsupported patch" }, { status: 400 });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }
    if (localRuntimeBlocked()) return await teardownOnBackend(id, { action: "destroy" });
    return NextResponse.json(await destroyProject(id));
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
