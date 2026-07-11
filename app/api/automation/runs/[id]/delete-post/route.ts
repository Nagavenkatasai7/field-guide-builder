import { NextResponse } from "next/server";
import { LinkedInAuthError, deletePost } from "@/lib/linkedin-api";
import { ensureValidToken } from "@/lib/daily-post";
import { getLinkedinAccount, getRun, updateRun } from "@/lib/storage";

export const runtime = "nodejs";

function badOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== new URL(request.url).host;
  } catch {
    return true;
  }
}

/** The one-click safety net: delete an already-posted run from LinkedIn. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  if (badOrigin(request)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const { id } = await ctx.params;
  const run = await getRun(id);
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  if (!run.linkedin_post_urn) return NextResponse.json({ error: "This run has no LinkedIn post to delete" }, { status: 400 });
  const account = await getLinkedinAccount();
  if (!account) return NextResponse.json({ error: "LinkedIn not connected" }, { status: 400 });
  try {
    // Refresh-if-needed so the safety net still works near token expiry.
    const { token } = await ensureValidToken(account);
    await deletePost(token, run.linkedin_post_urn);
    await updateRun(id, { status: "deleted" });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof LinkedInAuthError) {
      return NextResponse.json({ error: "LinkedIn token expired — reconnect LinkedIn, then retry the delete" }, { status: 401 });
    }
    const message = err instanceof Error ? err.message : "Delete failed";
    return NextResponse.json({ error: message.slice(0, 200) }, { status: 502 });
  }
}
