import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { timingSafeEqual } from "@/lib/auth";
import { exchangeCodeForToken, getMemberInfo, LINKEDIN_SCOPES } from "@/lib/linkedin-api";
import { upsertLinkedinAccount } from "@/lib/storage";

export const runtime = "nodejs";

/**
 * OAuth redirect target (matches the URL registered in the LinkedIn app:
 * /auth/linkedin/callback). Stays behind the password cookie — the redirect
 * back from linkedin.com is a top-level GET that carries the SameSite=Lax
 * fgb_auth cookie. Fail-closed CSRF check; single-use state cookie.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const home = (status: string) => NextResponse.redirect(new URL(`/?linkedin=${status}`, url.origin));

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const denied = url.searchParams.get("error");

  const jar = await cookies();
  const cookieState = jar.get("li_oauth_state")?.value;

  const clearState = (res: NextResponse) => {
    res.cookies.set("li_oauth_state", "", { path: "/", maxAge: 0 });
    return res;
  };

  if (denied) return clearState(home("denied"));
  // Fail closed: reject if EITHER side is missing/empty, then require equality.
  if (!code || !state || !cookieState) return clearState(home("csrf_error"));
  if (!timingSafeEqual(state, cookieState)) return clearState(home("csrf_error"));

  const redirectUri = process.env.LINKEDIN_REDIRECT_URI;
  if (!redirectUri) return clearState(home("config_error"));

  try {
    const token = await exchangeCodeForToken(code, redirectUri);
    const member = await getMemberInfo(token.accessToken);
    const tokenExpiresAt = new Date(Date.now() + token.expiresInSec * 1000).toISOString();
    await upsertLinkedinAccount({
      access_token: token.accessToken,
      refresh_token: token.refreshToken,
      token_expires_at: tokenExpiresAt,
      member_urn: member.memberUrn,
      member_name: member.name,
      scope: token.scope || LINKEDIN_SCOPES,
    });
    return clearState(home("connected"));
  } catch (err) {
    console.error(`[linkedin:callback] ${err instanceof Error ? err.message : String(err)}`);
    return clearState(home("exchange_error"));
  }
}
