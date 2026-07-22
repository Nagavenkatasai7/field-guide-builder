import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";

// /approve is the email-link approval page: reachable without the password
// cookie (the owner clicks from a mail client), but it can neither read nor
// change anything without a valid single-use token — the API routes below
// fail closed on signature, hash, status, and expiry.
const PUBLIC_PATHS = new Set(["/login", "/approve"]);
const PUBLIC_API_PREFIXES = ["/api/auth/login"];
// EXACT-match only (never startsWith): the cron endpoint carries no auth
// cookie and self-authenticates with CRON_SECRET; the approval endpoints
// self-authenticate with the signed capability token. Using a prefix here
// would also un-gate sibling/typo'd paths (/api/cron/daily-postX) and the
// manual run-now trigger — a public auto-post-to-LinkedIn hole. Keep it exact.
const PUBLIC_API_EXACT = new Set(["/api/cron/daily-post", "/api/approval/preview", "/api/approval/decide"]);

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();
  if (PUBLIC_API_EXACT.has(pathname)) return NextResponse.next();
  if (PUBLIC_API_PREFIXES.some((p) => pathname.startsWith(p))) return NextResponse.next();

  const token = request.cookies.get(AUTH_COOKIE)?.value;
  const ok = await verifySessionToken(token);
  if (ok) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const loginUrl = new URL("/login", request.url);
  if (pathname !== "/") loginUrl.searchParams.set("next", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
