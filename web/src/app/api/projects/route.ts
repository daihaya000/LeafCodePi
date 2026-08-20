import { NextRequest, NextResponse } from "next/server";
import { addProject, archiveProject, getProjects, jsonError } from "@/lib/pi/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ projects: getProjects() });
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
    if (body.archived) {
      return NextResponse.json({ project: archiveProject(body.id) });
    }
    return NextResponse.json({ error: "unsupported patch" }, { status: 400 });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
