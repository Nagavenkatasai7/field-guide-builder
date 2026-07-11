import { NextResponse } from "next/server";
import { z } from "zod";
import { generateDesignTheme, type DesignThemeT } from "@/lib/design-variant";

export const runtime = "nodejs";
export const maxDuration = 60;

const Body = z.object({
  topic: z.string().min(2).max(200),
  title: z.string().max(200).optional(),
});

export type DesignResponse = { ok: true; theme: DesignThemeT } | { ok: false; error: string };

/** Generates an optional per-topic design variant (manual flow only). */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" } satisfies DesignResponse, { status: 400 });
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Bad request" } satisfies DesignResponse, { status: 400 });
  }
  const theme = await generateDesignTheme(parsed.data.topic, parsed.data.title);
  if (!theme) {
    return NextResponse.json({ ok: false, error: "Could not generate a usable design — using the default." } satisfies DesignResponse);
  }
  return NextResponse.json({ ok: true, theme } satisfies DesignResponse);
}
