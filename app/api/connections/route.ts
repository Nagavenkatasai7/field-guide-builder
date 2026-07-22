import { NextResponse } from "next/server";
import { z } from "zod";
import { draftConnectionNotes, NOTE_MAX_CHARS } from "@/lib/connections";
import {
  insertConnectionTargets,
  listConnectionTargets,
  listPostedRuns,
  storageEnabled,
  type ConnectionTargetRow,
} from "@/lib/storage";

export const runtime = "nodejs";
export const maxDuration = 120;

export type ConnectionTargetWire = {
  id: string;
  createdAt: string;
  company: string;
  roleHint: string | null;
  note: string;
  status: "fresh" | "sent" | "dismissed";
};

export type ConnectionsResponse = { enabled: boolean; noteMaxChars: number; items: ConnectionTargetWire[] };

function toWire(r: ConnectionTargetRow): ConnectionTargetWire {
  return { id: r.id, createdAt: r.created_at, company: r.company, roleHint: r.role_hint, note: r.note, status: r.status };
}

export async function GET() {
  if (!storageEnabled()) return NextResponse.json({ enabled: false, noteMaxChars: NOTE_MAX_CHARS, items: [] } satisfies ConnectionsResponse);
  const items = await listConnectionTargets(40);
  return NextResponse.json({ enabled: true, noteMaxChars: NOTE_MAX_CHARS, items: items.map(toWire) } satisfies ConnectionsResponse);
}

const Body = z.object({
  companies: z.array(z.object({
    company: z.string().min(2).max(120),
    roleHint: z.string().max(120).optional(),
  })).min(1).max(10),
});

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

/** Draft notes for up to 10 companies at a time. The latest posted guide is
 * the shared-interest anchor the prompt references. */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  if (!storageEnabled()) return NextResponse.json({ error: "Storage not configured" }, { status: 400 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });

  try {
    const latest = (await listPostedRuns(1))[0] ?? null;
    const drafted = await draftConnectionNotes(
      parsed.data.companies.map((c) => ({ company: c.company.trim(), roleHint: c.roleHint?.trim() || null })),
      latest ? { title: latest.plan_title, topic: latest.topic } : null,
    );
    await insertConnectionTargets(drafted);
    const items = await listConnectionTargets(40);
    return NextResponse.json({ enabled: true, noteMaxChars: NOTE_MAX_CHARS, items: items.map(toWire) } satisfies ConnectionsResponse);
  } catch (err) {
    const message = err instanceof Error ? err.message : "drafting failed";
    return NextResponse.json({ error: message.slice(0, 300) }, { status: 502 });
  }
}
