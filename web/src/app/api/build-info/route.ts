import { dirname, resolve } from "node:path";
import { NextResponse } from "next/server";
import { runGit } from "@/lib/git";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const skillsDir = process.env.LEAFCODE_PI_SKILLS_DIR?.trim()
    ? resolve(process.env.LEAFCODE_PI_SKILLS_DIR)
    : resolve(process.cwd(), "..", "skills");

  try {
    const result = await runGit(dirname(skillsDir), ["log", "-1", "--format=%H%n%cI"], 2_000);
    const [commit, committedAt] = result.stdout.trim().split(/\r?\n/);
    if (result.code !== 0 || !commit || !committedAt) {
      return NextResponse.json({ commit: null, committedAt: null }, { status: 503 });
    }
    return NextResponse.json({ commit, committedAt });
  } catch {
    return NextResponse.json({ commit: null, committedAt: null }, { status: 503 });
  }
}
