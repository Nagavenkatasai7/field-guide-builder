import { NextResponse } from "next/server";
import { z } from "zod";
import { Plan } from "@/lib/plan-schema";
import { generateLinkedinCaption } from "@/lib/pipeline";

export const runtime = "nodejs";
export const maxDuration = 60;

const Body = z.object({
  plan: Plan,
  angle: z.string().max(1000).optional(),
  // Optional research sources so the caption can quote real numbers; the
  // client already holds them after /api/research.
  sources: z
    .array(z.object({ title: z.string().max(300), url: z.string().max(2000), excerpt: z.string().max(4000) }))
    .max(12)
    .optional(),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Bad request", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    // Caption generation is shared with the cron path via lib/pipeline.ts.
    const { post, meta } = await generateLinkedinCaption(parsed.data.plan, parsed.data.angle, parsed.data.sources);
    console.log(
      `[linkedin] ${post.length} chars — ${meta.model}, ${meta.tokensIn} in / ${meta.tokensOut} out tokens in ${meta.durationMs}ms`,
    );
    return NextResponse.json({ post, meta });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[linkedin] failed: ${message}`);
    return NextResponse.json({ error: `LinkedIn caption failed: ${message}` }, { status: 500 });
  }
}
