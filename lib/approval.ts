/**
 * Approval-mode helpers (M12): capability tokens for the emailed approve link,
 * plus final-caption composition (owner's personal take + generated caption).
 *
 * Token: `v1.<runId>.<exp>.<nonce>.<sig>` where
 *   sig = HMAC-SHA256("approve:v1:<runId>:<exp>:<nonce>", AUTH_COOKIE_SECRET).
 * The RAW token travels only inside the alert email; the DB stores an HMAC
 * hash of it (scheduled_runs.approval_token_hash), so neither a DB read nor a
 * log line can reconstruct a working approve link. Single-use is enforced by
 * the atomic status flip in the decide route (awaiting_approval → approved /
 * skipped clears the hash), and re-issuing a link rotates the hash, which
 * invalidates every previously emailed link for that run.
 */

import { hmacSign, timingSafeEqual } from "@/lib/auth";

/** How long an approve link stays clickable. After this, the reaper sweeps the
 * run to 'skipped' — a day-old field guide is stale content, not a backlog. */
export const APPROVAL_TTL_HOURS = 24;

const TOKEN_VERSION = "v1";

export type MintedApprovalToken = {
  token: string;
  /** HMAC of the token — the only form that may touch the database. */
  tokenHash: string;
  /** ISO timestamp for scheduled_runs.approval_expires_at. */
  expiresAt: string;
};

function nonce(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

export async function hashApprovalToken(token: string): Promise<string> {
  // Domain-separated so this HMAC can never collide with a signature.
  return hmacSign(`approve-hash:${TOKEN_VERSION}:${token}`);
}

export async function mintApprovalToken(runId: string): Promise<MintedApprovalToken> {
  const exp = Math.floor(Date.now() / 1000) + APPROVAL_TTL_HOURS * 3600;
  const n = nonce();
  const sig = await hmacSign(`approve:${TOKEN_VERSION}:${runId}:${exp}:${n}`);
  const token = `${TOKEN_VERSION}.${runId}.${exp}.${n}.${sig}`;
  return {
    token,
    tokenHash: await hashApprovalToken(token),
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

/** Signature + expiry check only — the caller must ALSO compare the token's
 * hash against the stored approval_token_hash (that binds the token to the
 * run row and gives single-use/rotation semantics). */
export async function verifyApprovalToken(token: string): Promise<{ ok: true; runId: string } | { ok: false }> {
  const parts = token.split(".");
  if (parts.length !== 5) return { ok: false };
  const [version, runId, expStr, n, sig] = parts;
  if (version !== TOKEN_VERSION || !runId || !n || !sig) return { ok: false };
  const exp = Number.parseInt(expStr, 10);
  if (!Number.isFinite(exp)) return { ok: false };
  if (Math.floor(Date.now() / 1000) >= exp) return { ok: false };
  let expected: string;
  try {
    expected = await hmacSign(`approve:${TOKEN_VERSION}:${runId}:${exp}:${n}`);
  } catch {
    return { ok: false };
  }
  if (!timingSafeEqual(sig, expected)) return { ok: false };
  return { ok: true, runId };
}

/**
 * Public origin for links placed in emails. No new required config: falls back
 * to the origin of LINKEDIN_REDIRECT_URI (always set in prod for posting),
 * then Vercel's production-domain env, then local dev.
 */
export function appBaseUrl(): string {
  const explicit = process.env.APP_BASE_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  const redirect = process.env.LINKEDIN_REDIRECT_URI;
  if (redirect) {
    try {
      return new URL(redirect).origin;
    } catch {
      /* fall through */
    }
  }
  const vercelHost = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (vercelHost) return `https://${vercelHost}`;
  return "http://localhost:3838";
}

export const PERSONAL_TAKE_MAX_CHARS = 600;

/**
 * Prepend the owner's personal take to the generated caption. The composed
 * result still goes through guardCaption (URL/mention stripping, length
 * bounds) before posting — this only normalizes and joins.
 */
export function composeFinalCaption(personalTake: string | null | undefined, caption: string): string {
  const take = (personalTake ?? "").replace(/\s+/g, " ").trim().slice(0, PERSONAL_TAKE_MAX_CHARS);
  if (!take) return caption;
  return `${take}\n\n${caption}`;
}
