const COOKIE_NAME = "fgb_auth";
const SEVEN_DAYS_SECONDS = 60 * 60 * 24 * 7;

function getSecret(): string {
  const secret = process.env.AUTH_COOKIE_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("AUTH_COOKIE_SECRET is missing or too short (need 32+ chars)");
  }
  return secret;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacSha256(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return bytesToBase64Url(new Uint8Array(sig));
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function createSessionToken(maxAgeSeconds = SEVEN_DAYS_SECONDS): Promise<string> {
  const expiresAt = Math.floor(Date.now() / 1000) + maxAgeSeconds;
  const payload = String(expiresAt);
  const sig = await hmacSha256(payload, getSecret());
  return `${payload}.${sig}`;
}

export async function verifySessionToken(token: string | undefined | null): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);
  const expiresAt = Number.parseInt(payload, 10);
  if (!Number.isFinite(expiresAt)) return false;
  if (Math.floor(Date.now() / 1000) >= expiresAt) return false;
  let expectedSig: string;
  try {
    expectedSig = await hmacSha256(payload, getSecret());
  } catch {
    return false;
  }
  return timingSafeEqual(providedSig, expectedSig);
}

export function checkPassword(submitted: string): boolean {
  const expected = process.env.AUTH_PASSWORD;
  if (!expected || expected.length < 8) return false;
  if (submitted.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < submitted.length; i++) diff |= submitted.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export const AUTH_COOKIE = COOKIE_NAME;
export const AUTH_MAX_AGE = SEVEN_DAYS_SECONDS;

/**
 * Verifies the `Authorization: Bearer <secret>` header that Vercel Cron sends
 * when CRON_SECRET is configured in the project env. This is the ENTIRE
 * security boundary on the public /api/cron/daily-post route, so it is
 * deliberately FAIL-CLOSED:
 *   - returns false if CRON_SECRET is unset or shorter than 16 chars (so a
 *     missing/empty secret can never be matched by "Bearer undefined"),
 *   - compares in constant time via timingSafeEqual.
 * Never inline a raw `=== \`Bearer ${process.env.CRON_SECRET}\`` check — that
 * matches "Bearer undefined" when the env var is absent and leaks timing.
 */
export function verifyCronSecret(authHeader: string | null | undefined): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return false;
  if (!authHeader) return false;
  const prefix = "Bearer ";
  if (!authHeader.startsWith(prefix)) return false;
  const provided = authHeader.slice(prefix.length);
  return timingSafeEqual(provided, secret);
}
