import { NextResponse } from "next/server";
import { z } from "zod";
import { findEngagementTargets } from "@/lib/engagement";
import { nyDateString } from "@/lib/daily-post";
import {
  getAutomationSettings,
  insertEngagementItems,
  listEngagementItems,
  recentEngagementUrls,
  storageEnabled,
  type EngagementItemRow,
} from "@/lib/storage";

export const runtime = "nodejs";
// Tavily sweep + one LLM drafting call — well under the cap, but not 30s.
export const maxDuration = 300;

export type EngagementItemWire = {
  id: string;
  createdAt: string;
  url: string;
  title: string;
  snippet: string | null;
  source: "linkedin" | "article";
  draftComment: string;
  status: "fresh" | "used" | "dismissed";
};

export type EngagementResponse = { enabled: boolean; itemDate: string; items: EngagementItemWire[] };

function toWire(r: EngagementItemRow): EngagementItemWire {
  return {
    id: r.id,
    createdAt: r.created_at,
    url: r.url,
    title: r.title,
    snippet: r.snippet,
    source: r.source,
    draftComment: r.draft_comment,
    status: r.status,
  };
}

export async function GET() {
  const today = nyDateString();
  if (!storageEnabled()) return NextResponse.json({ enabled: false, itemDate: today, items: [] } satisfies EngagementResponse);
  const items = await listEngagementItems(today);
  return NextResponse.json({ enabled: true, itemDate: today, items: items.map(toWire) } satisfies EngagementResponse);
}

const Body = z.object({ force: z.boolean().optional() });

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

/** Generate today's cockpit. Idempotent per day unless force — a second click
 * returns the existing list instead of burning Tavily/LLM credits. */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  if (!storageEnabled()) return NextResponse.json({ error: "Storage not configured" }, { status: 400 });
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    /* empty body → defaults */
  }
  const parsed = Body.safeParse(body ?? {});
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });

  const settings = await getAutomationSettings();
  const today = nyDateString(settings.timezone);
  const existing = await listEngagementItems(today);
  if (existing.length > 0 && !parsed.data.force) {
    return NextResponse.json({ enabled: true, itemDate: today, items: existing.map(toWire) } satisfies EngagementResponse);
  }

  try {
    const targets = await findEngagementTargets(await recentEngagementUrls());
    await insertEngagementItems(today, targets);
    const items = await listEngagementItems(today);
    return NextResponse.json({ enabled: true, itemDate: today, items: items.map(toWire) } satisfies EngagementResponse);
  } catch (err) {
    const message = err instanceof Error ? err.message : "generation failed";
    return NextResponse.json({ error: message.slice(0, 300) }, { status: 502 });
  }
}
