import { NextRequest, NextResponse } from "next/server";
import { ensureRoutineScheduler, getRoutine, runRoutine } from "@/lib/routines";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string; routineId: string }> }) { const { id, routineId } = await params; ensureRoutineScheduler(); if (!getRoutine(id, routineId)) return NextResponse.json({ error: "\u30eb\u30fc\u30c6\u30a3\u30f3\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093" }, { status: 404 }); try { return NextResponse.json({ routine: await runRoutine(id, routineId) }); } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "\u30eb\u30fc\u30c6\u30a3\u30f3\u306e\u5b9f\u884c\u306b\u5931\u6557\u3057\u307e\u3057\u305f", routine: getRoutine(id, routineId) }, { status: 500 }); } }
