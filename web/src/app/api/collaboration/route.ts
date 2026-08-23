import { NextRequest, NextResponse } from "next/server";
import { getProjects, jsonError } from "@/lib/pi/harness";
import { discardCollaborationLease } from "@/lib/collaboration-room-actions";
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

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null) as { projectId?: unknown; action?: unknown; leaseId?: unknown } | null;
    const projectId = typeof body?.projectId === "string" ? body.projectId.trim() : "";
    const action = typeof body?.action === "string" ? body.action.trim() : "";
    const leaseId = typeof body?.leaseId === "string" ? body.leaseId : "";
    if (!projectId) return NextResponse.json({ error: "projectId is required" }, { status: 400 });
    if (action !== "discard") return NextResponse.json({ error: "unsupported collaboration action" }, { status: 400 });
    const project = getProjects(true).find((entry) => entry.id === projectId);
    if (!project) return NextResponse.json({ error: "project not found" }, { status: 404 });
    const room = await discardCollaborationLease(project.rootPath, leaseId);
    return NextResponse.json({ projectId, room });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
