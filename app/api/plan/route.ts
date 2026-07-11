import { z } from "zod";
import { generatePlan } from "@/lib/pipeline";

export const runtime = "nodejs";
// Production /api/plan was hitting Vercel Runtime Timeout at 60s because
// Ollama Cloud round-trips from iad1 add ~50% latency vs local. 300s is
// the Hobby+Fluid Compute ceiling.
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
  topic: z.string().min(2).max(200),
  summary: z.string().max(1000).default(""),
  sources: z.array(SourceShape).min(1).max(20),
});

type SSEController = ReadableStreamDefaultController<Uint8Array>;
function sse(controller: SSEController, event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  controller.enqueue(new TextEncoder().encode(payload));
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

  const input = parsed.data;
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

      try {
        sse(controller, "status", { phase: "start", message: `Planning "${input.topic}"…`, elapsedMs: 0 });

        heartbeat = setInterval(() => {
          sse(controller, "status", {
            phase: "thinking",
            message: "Gemma 4 reasoning about structure…",
            elapsedMs: Date.now() - startedAt,
          });
        }, 2500);

        // Generation (incl. the stricter-retry) is shared with the cron path
        // via lib/pipeline.ts. The onRetry callback preserves the cosmetic
        // "retry" status event the UI showed before.
        const { plan, meta } = await generatePlan(input, {
          onRetry: () =>
            sse(controller, "status", { phase: "retry", message: "Plan didn't validate — retrying once.", elapsedMs: Date.now() - startedAt }),
        });
        stopHeartbeat();

        console.log(
          `[plan] "${input.topic}" → ${plan.sections.length} sections, ${plan.infographics.length} infographics — ${meta.model}, ${meta.tokensIn} in / ${meta.tokensOut} out tokens in ${meta.durationMs}ms`,
        );

        sse(controller, "plan", { plan, meta });
        sse(controller, "done", { elapsedMs: Date.now() - startedAt });
      } catch (err) {
        stopHeartbeat();
        const message = err instanceof Error ? err.message : "Unknown error";
        console.error(`[plan] failed: ${message}`);
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
