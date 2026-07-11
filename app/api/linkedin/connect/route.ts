import { NextResponse } from "next/server";
import { getAuthorizationUrl } from "@/lib/linkedin-api";

export const runtime = "nodejs";

/**
 * Starts the OAuth flow: mint a CSRF state, stash it in a SameSite=Lax cookie
 * (must survive the top-level redirect back from linkedin.com), and redirect
 * the browser to LinkedIn's authorize screen. Behind the password cookie
 * (proxy.ts protects /api/*).
 */
export async function GET() {
  const redirectUri = process.env.LINKEDIN_REDIRECT_URI;
  if (!redirectUri) {
    return NextResponse.json({ error: "LINKEDIN_REDIRECT_URI is not configured" }, { status: 500 });
  }
  const state = crypto.randomUUID();
  const res = NextResponse.redirect(getAuthorizationUrl(state, redirectUri));
  res.cookies.set("li_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return res;
}
