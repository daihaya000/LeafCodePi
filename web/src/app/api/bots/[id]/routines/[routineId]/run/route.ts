import { NextRequest, NextResponse } from "next/server";
import { ensureRoutineScheduler, getRoutine, runRoutine } from "@/lib/routines";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string; routineId: string }> }) { const { id, routineId } = await params; ensureRoutineScheduler(); if (!getRoutine(id, routineId)) return NextResponse.json({ error: "Routine not found" }, { status: 404 }); try { return NextResponse.json({ routine: await runRoutine(id, routineId) }); } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Routine failed", routine: getRoutine(id, routineId) }, { status: 500 }); } }