import { z } from "zod";
import { Plan } from "@/lib/plan-schema";
import { isDraftable } from "@/lib/prompts/draft";
import { draftSections, type DraftEvent } from "@/lib/pipeline";

export const runtime = "nodejs";
// Ollama Cloud network round-trips add ~2x latency vs local. 300s is the
// Hobby+Fluid Compute ceiling and covers worst-case 12-section drafts.
export const maxDuration = 300;

const SourceShape = z.object({
  title: z.string(),
  url: z.string(),
  excerpt: z.string(),
  rawContent: z.string(),
  score: z.number(),
  publishedDate: z.string().optional(),
  origin: z.enum(["search", "user"]),
});

const Body = z.object({
  plan: Plan,
  sources: z.array(SourceShape).min(1).max(20),
});

type SSEController = ReadableStreamDefaultController<Uint8Array>;
function sse(controller: SSEController, event: string, data: unknown) {
  controller.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: "Bad request", details: parsed.error.flatten() }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { plan, sources } = parsed.data;
  const draftable = plan.sections.filter((s) => isDraftable(s.kind));
  const skipped = plan.sections.filter((s) => !isDraftable(s.kind));

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const startedAt = Date.now();
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      const stopHeartbeat = () => {
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
      };
      let completed = 0;
      let failed = 0;

      try {
        sse(controller, "start", {
          totalSections: plan.sections.length,
          draftSections: draftable.length,
          skippedSections: skipped.map((s) => ({ id: s.id, kind: s.kind })),
        });

        heartbeat = setInterval(() => {
          sse(controller, "status", {
            message: `Drafting (${completed}/${draftable.length} done${failed ? `, ${failed} failed` : ""})…`,
            elapsedMs: Date.now() - startedAt,
          });
        }, 2000);

        // Generation is shared with the cron path via lib/pipeline.ts; the
        // onSection callback re-emits each per-section SSE event identically.
        const { meta } = await draftSections(plan, sources, {
          onSection: (ev: DraftEvent) => {
            if (ev.error) failed++;
            else completed++;
            sse(controller, "section", ev);
          },
        });

        stopHeartbeat();
        console.log(
          `[draft] ${meta.completed}/${draftable.length} sections (failed ${meta.failed}) — ${meta.model}, ${meta.totalTokensIn} in / ${meta.totalTokensOut} out tokens in ${meta.durationMs}ms`,
        );
        sse(controller, "done", {
          completed: meta.completed,
          failed: meta.failed,
          totalTokensIn: meta.totalTokensIn,
          totalTokensOut: meta.totalTokensOut,
          durationMs: meta.durationMs,
          model: meta.model,
        });
      } catch (err) {
        stopHeartbeat();
        const message = err instanceof Error ? err.message : "Unknown error";
        console.error(`[draft] fatal: ${message}`);
        sse(controller, "error", { message });
      } finally {
        stopHeartbeat();
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
