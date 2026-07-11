import { NextResponse } from "next/server";
import { clearLinkedinAccount } from "@/lib/storage";

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

export async function POST(request: Request) {
  if (badOrigin(request)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  await clearLinkedinAccount();
  return NextResponse.json({ ok: true });
}
