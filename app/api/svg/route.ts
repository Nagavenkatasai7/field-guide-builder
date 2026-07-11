import { z } from "zod";
import { Plan } from "@/lib/plan-schema";
import { generateSvgs, type SvgEvent } from "@/lib/pipeline";

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({
  plan: Plan,
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

  const { plan } = parsed.data;
  const infographics = plan.infographics;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const startedAt = Date.now();
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      const stopHeartbeat = () => {
        if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      };
      let completed = 0;
      let failed = 0;

      try {
        sse(controller, "start", { infographicCount: infographics.length });

        heartbeat = setInterval(() => {
          sse(controller, "status", {
            message: `Drawing diagrams (${completed}/${infographics.length}${failed ? `, ${failed} failed` : ""})…`,
            elapsedMs: Date.now() - startedAt,
          });
        }, 2500);

        // Generation is shared with the cron path via lib/pipeline.ts; the
        // onSvg callback re-emits each per-diagram SSE event identically.
        const { meta } = await generateSvgs(plan, {
          onSvg: (ev: SvgEvent) => {
            if (ev.error) failed++;
            else completed++;
            sse(controller, "svg", ev);
          },
        });

        stopHeartbeat();
        console.log(
          `[svg] ${meta.completed}/${infographics.length} diagrams (failed ${meta.failed}) — ${meta.model}, ${meta.totalTokensIn} in / ${meta.totalTokensOut} out tokens in ${meta.durationMs}ms`,
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
        console.error(`[svg] fatal: ${message}`);
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
