import { NextResponse } from "next/server";
import { z } from "zod";
import { draftReply } from "@/lib/engagement";

export const runtime = "nodejs";
export const maxDuration = 60;

const Body = z.object({
  theirComment: z.string().min(2).max(2000),
  postTopic: z.string().max(300).optional(),
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

/** Drafts a reply to a comment the owner PASTES in (the API can't read
 * comments — r_member_social is partner-gated — and we wouldn't auto-reply
 * anyway). Stateless: nothing is stored. */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  try {
    const reply = await draftReply(parsed.data);
    return NextResponse.json({ reply });
  } catch (err) {
    const message = err instanceof Error ? err.message : "drafting failed";
    return NextResponse.json({ error: message.slice(0, 300) }, { status: 502 });
  }
}
