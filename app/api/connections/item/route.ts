import { NextResponse } from "next/server";
import { z } from "zod";
import { setConnectionTargetStatus, storageEnabled } from "@/lib/storage";

export const runtime = "nodejs";
export const maxDuration = 30;

const Body = z.object({
  id: z.string().min(4).max(64),
  status: z.enum(["fresh", "sent", "dismissed"]),
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
  const ok = await setConnectionTargetStatus(parsed.data.id, parsed.data.status);
  if (!ok) return NextResponse.json({ error: "Item not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
