import { NextResponse } from "next/server";
import { runDailyPost } from "@/lib/daily-post";
import { getRun } from "@/lib/storage";

export const runtime = "nodejs";
export const maxDuration = 300;

function badOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== new URL(request.url).host;
  } catch {
    return true;
  }
}

/**
 * Retry a FAILED or BLOCKED (pre-post) run, reusing its stored topic. Refused
 * for posting/posted/needs_review/dry_run so a retry can never double-post.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  if (badOrigin(request)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const { id } = await ctx.params;
  const run = await getRun(id);
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  if (run.status !== "failed" && run.status !== "blocked") {
    return NextResponse.json({ error: `Only failed/blocked runs can be retried (this is '${run.status}')` }, { status: 400 });
  }
  if (!run.topic) return NextResponse.json({ error: "No stored topic to retry" }, { status: 400 });
  try {
    const summary = await runDailyPost("manual", {
      dryRun: run.dry_run,
      topicOverride: { topic: run.topic, angle: run.angle ?? "", urls: undefined },
    });
    return NextResponse.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Retry failed";
    return NextResponse.json({ error: message.slice(0, 200) }, { status: 500 });
  }
}
