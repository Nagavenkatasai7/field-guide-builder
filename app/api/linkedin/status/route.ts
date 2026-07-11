import { NextResponse } from "next/server";
import { getLinkedinStatus, storageEnabled, type LinkedinStatus } from "@/lib/storage";

export const runtime = "nodejs";

/** Token-free connection status for the panel. Never returns access/refresh tokens. */
export async function GET() {
  if (!storageEnabled()) return NextResponse.json({ connected: false } satisfies LinkedinStatus);
  return NextResponse.json(await getLinkedinStatus());
}
