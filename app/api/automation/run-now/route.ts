import { NextResponse } from "next/server";
import { z } from "zod";
import { runDailyPost } from "@/lib/daily-post";

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({
  dryRun: z.boolean().default(true),
  // Optional explicit topic override (used to post a hand-picked / scouted topic
  // instead of the auto-picker). When omitted, runDailyPost auto-picks.
  topic: z.string().min(2).max(200).optional(),
  angle: z.string().max(1000).optional(),
  urls: z.array(z.string().url()).max(3).optional(),
});

/** Same-origin guard (cheap CSRF hardening for a state-changing POST). */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true; // non-browser / same-origin fetch without Origin
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  // proxy.ts already enforces the password cookie on /api/* (this path is NOT
  // public). The Origin check is defense-in-depth.
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    /* empty body → defaults (dry-run) */
  }
  const parsed = Body.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  try {
    const { dryRun, topic, angle, urls } = parsed.data;
    const topicOverride = topic ? { topic, angle: angle ?? "", urls } : undefined;
    const summary = await runDailyPost("manual", { dryRun, topicOverride });
    return NextResponse.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
