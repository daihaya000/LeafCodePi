import { NextRequest, NextResponse } from "next/server";
import {
  addProject,
  archiveProject,
  destroyProject,
  getProjects,
  jsonError,
  restoreProject,
} from "@/lib/pi/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const includeArchived = req.nextUrl.searchParams.get("archived") === "1";
  return NextResponse.json({ projects: getProjects(includeArchived) });
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
    const body = (await req.json().catch(() => null)) as { id?: string; archived?: boolean } | null;
    if (!body?.id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }
    if (body.archived === true) {
      return NextResponse.json({ project: archiveProject(body.id) });
    }
    if (body.archived === false) {
      return NextResponse.json({ project: restoreProject(body.id) });
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
    return NextResponse.json(destroyProject(id));
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
