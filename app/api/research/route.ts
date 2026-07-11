import { NextResponse } from "next/server";
import { z } from "zod";
import { research, type ResearchSource } from "@/lib/tavily";

export const runtime = "nodejs";
export const maxDuration = 60;

const Body = z.object({
  topic: z.string().min(2).max(200),
  urls: z.array(z.string().url()).max(20).default([]),
  summary: z.string().max(1000).default(""),
});

export type ResearchSourceWire = ResearchSource;

export type ResearchResponse = {
  topic: string;
  query: string;
  sources: ResearchSourceWire[];
  responseTimeMs: number;
  credits?: number;
};

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

  const { topic, urls, summary } = parsed.data;

  try {
    const result = await research({ topic, urls, summary });
    console.log(
      `[research] "${topic}" → ${result.sources.length} sources in ${result.responseTimeMs}ms` +
        (result.credits != null ? ` (Tavily credits: ${result.credits})` : ""),
    );
    const response: ResearchResponse = {
      topic,
      query: result.query,
      sources: result.sources,
      responseTimeMs: result.responseTimeMs,
      credits: result.credits,
    };
    return NextResponse.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[research] failed: ${message}`);
    if (message.includes("TAVILY_API_KEY")) {
      return NextResponse.json({ error: "Tavily API key not configured" }, { status: 500 });
    }
    return NextResponse.json({ error: `Research failed: ${message}` }, { status: 502 });
  }
}
