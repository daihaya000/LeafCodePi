import { NextRequest, NextResponse } from "next/server";
import { getProjects, jsonError } from "@/lib/pi/harness";
import { readCollaborationRoom } from "@/lib/collaboration-room";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const projectId = req.nextUrl.searchParams.get("projectId");
    const projects = getProjects(true);
    if (projectId) {
      const project = projects.find((entry) => entry.id === projectId);
      if (!project) return NextResponse.json({ error: "project not found" }, { status: 404 });
      return NextResponse.json({ projectId, room: readCollaborationRoom(project.rootPath) });
    }
    return NextResponse.json({
      rooms: Object.fromEntries(projects.map((project) => [project.id, readCollaborationRoom(project.rootPath)])),
    });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
