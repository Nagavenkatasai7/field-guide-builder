/**
 * LinkedIn REST client — dependency-free (global fetch), Node runtime.
 *
 * Implements the seven interactions the daily-poster needs:
 *   OAuth authorize URL · code→token · token refresh · member userinfo ·
 *   document upload (initializeUpload → PUT → poll) · document post · delete.
 *
 * Verified against LinkedIn / Microsoft Learn docs (li-lms 2026):
 *   - Posting a PDF *document* to a personal profile uses the self-serve
 *     w_member_social scope; for person-owned documents the only check is
 *     "caller must match the document owner" (no partner approval).
 *   - The created post URN arrives in the `x-restli-id` RESPONSE HEADER.
 *   - GET a single document uses the URN UNENCODED in the path; DELETE a post
 *     uses the URN URL-ENCODED *and* requires header `X-RestLi-Method: DELETE`.
 *   - All /rest/* calls need `X-Restli-Protocol-Version: 2.0.0` and
 *     `LinkedIn-Version: YYYYMM`.
 *
 * Tokens are never logged. Error bodies are reduced to {message,status,code}
 * — never raw HTML — so nothing sensitive lands in logs or the run log.
 */

const AUTH_URL = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const USERINFO_URL = "https://api.linkedin.com/v2/userinfo";
const REST_BASE = "https://api.linkedin.com/rest";

/** Minimal scope: openid+profile give us the person URN (sub); w_member_social writes. No `email`. */
export const LINKEDIN_SCOPES = "openid profile w_member_social";

const MAX_PDF_BYTES = 100 * 1024 * 1024; // LinkedIn 100MB limit
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 20; // 20 × 2s = ~40s, comfortably inside the shared 300s budget
const FETCH_TIMEOUT_MS = 20_000; // per-request cap so a hung connection can't stall the unattended run
const UPLOAD_TIMEOUT_MS = 60_000; // the raw bytes PUT gets more headroom

/** fetch with a per-request abort timeout (a single hung call can't block the cron). */
function tfetch(url: string, init: RequestInit, ms = FETCH_TIMEOUT_MS): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}

function getClientId(): string {
  const v = process.env.LINKEDIN_CLIENT_ID;
  if (!v) throw new Error("LINKEDIN_CLIENT_ID is not set");
  return v;
}
function getClientSecret(): string {
  const v = process.env.LINKEDIN_CLIENT_SECRET;
  if (!v) throw new Error("LINKEDIN_CLIENT_SECRET is not set");
  return v;
}
export function getApiVersion(): string {
  return process.env.LINKEDIN_API_VERSION || "202509";
}

// --- error taxonomy (callers branch on instanceof) ---

export class LinkedInApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly serviceErrorCode?: number) {
    super(message);
    this.name = new.target.name;
  }
}
export class LinkedInAuthError extends LinkedInApiError {}        // 401 / expired token → refresh or reconnect
export class LinkedInPermissionError extends LinkedInApiError {}  // 403 → check app products/scopes
export class LinkedInProcessingError extends LinkedInApiError {}  // document PROCESSING_FAILED
export class LinkedInTimeoutError extends LinkedInApiError {}     // document never reached AVAILABLE

function restHeaders(token: string, extra?: Record<string, string>): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "X-Restli-Protocol-Version": "2.0.0",
    "LinkedIn-Version": getApiVersion(),
    ...extra,
  };
}

/** Reduce any LinkedIn error response to a safe, short, typed error. Never includes raw HTML or tokens. */
async function toError(res: Response, op: string): Promise<LinkedInApiError> {
  let message = res.statusText || "request failed";
  let code: number | undefined;
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text) as { message?: string; error_description?: string; error?: string; serviceErrorCode?: number };
      message = j.message || j.error_description || j.error || message;
      code = j.serviceErrorCode;
    } catch {
      message = (text || "").replace(/\s+/g, " ").trim().slice(0, 160) || message;
    }
  } catch {
    /* ignore body read errors */
  }
  const full = `[linkedin:${op}] ${res.status}: ${message}`;
  if (res.status === 401) return new LinkedInAuthError(full, res.status, code);
  if (res.status === 403) return new LinkedInPermissionError(full, res.status, code);
  return new LinkedInApiError(full, res.status, code);
}

// --- OAuth ---

export function getAuthorizationUrl(state: string, redirectUri: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: getClientId(),
    redirect_uri: redirectUri,
    state,
    scope: LINKEDIN_SCOPES,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export type LinkedInToken = {
  accessToken: string;
  refreshToken: string | null;
  expiresInSec: number;
  refreshExpiresInSec: number | null;
  scope: string;
};

type TokenWire = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope?: string;
};

async function postToken(form: URLSearchParams, op: string): Promise<LinkedInToken> {
  const res = await tfetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (!res.ok) throw await toError(res, op);
  const j = (await res.json()) as TokenWire;
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token ?? null,
    expiresInSec: j.expires_in,
    refreshExpiresInSec: j.refresh_token_expires_in ?? null,
    scope: j.scope ?? LINKEDIN_SCOPES,
  };
}

export function exchangeCodeForToken(code: string, redirectUri: string): Promise<LinkedInToken> {
  return postToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: getClientId(),
      client_secret: getClientSecret(),
    }),
    "token-exchange",
  );
}

export function refreshAccessToken(refreshToken: string): Promise<LinkedInToken> {
  return postToken(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: getClientId(),
      client_secret: getClientSecret(),
    }),
    "token-refresh",
  );
}

export async function getMemberInfo(accessToken: string): Promise<{ memberUrn: string; name: string }> {
  const res = await tfetch(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw await toError(res, "userinfo");
  const j = (await res.json()) as { sub: string; name?: string; given_name?: string };
  return { memberUrn: `urn:li:person:${j.sub}`, name: j.name || j.given_name || "LinkedIn member" };
}

// --- Documents + Posts ---

/** Initialize → PUT bytes → poll until AVAILABLE. Returns the document URN. */
export async function uploadDocument(accessToken: string, ownerUrn: string, pdf: Buffer): Promise<string> {
  if (pdf.length > MAX_PDF_BYTES) {
    throw new LinkedInApiError(`[linkedin:upload] PDF is ${pdf.length} bytes, exceeds 100MB limit`, 0);
  }

  // 1. initializeUpload
  const initRes = await tfetch(`${REST_BASE}/documents?action=initializeUpload`, {
    method: "POST",
    headers: restHeaders(accessToken, { "Content-Type": "application/json" }),
    body: JSON.stringify({ initializeUploadRequest: { owner: ownerUrn } }),
  });
  if (!initRes.ok) throw await toError(initRes, "doc-init");
  const init = (await initRes.json()) as { value?: { uploadUrl?: string; document?: string } };
  const uploadUrl = init.value?.uploadUrl;
  const documentUrn = init.value?.document;
  if (!uploadUrl || !documentUrn) {
    throw new LinkedInApiError("[linkedin:upload] initializeUpload missing uploadUrl/document", initRes.status);
  }

  // 2. upload the bytes (single-use, time-limited URL → PUT immediately)
  const putRes = await tfetch(
    uploadUrl,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(pdf),
    },
    UPLOAD_TIMEOUT_MS,
  );
  if (!putRes.ok && putRes.status !== 201) throw await toError(putRes, "doc-put");

  // 3. poll until AVAILABLE. The URN MUST be URL-encoded in the path — Rest.li
  // 2.0.0 rejects the raw colons with "Syntax exception in path variables"
  // (the docs' unencoded example is misleading; verified empirically).
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const getRes = await tfetch(`${REST_BASE}/documents/${encodeURIComponent(documentUrn)}`, { headers: restHeaders(accessToken) });
    if (!getRes.ok) throw await toError(getRes, "doc-poll");
    const doc = (await getRes.json()) as { status?: string };
    if (doc.status === "AVAILABLE") return documentUrn;
    if (doc.status === "PROCESSING_FAILED") {
      throw new LinkedInProcessingError("[linkedin:upload] document processing failed", getRes.status);
    }
    // WAITING_UPLOAD / PROCESSING → keep polling
  }
  throw new LinkedInTimeoutError(`[linkedin:upload] document not AVAILABLE after ${POLL_MAX_ATTEMPTS} polls`, 0);
}

const POST_URN_RE = /^urn:li:(share|ugcPost):[0-9A-Za-z_-]+$/;

/**
 * Creates the document post. `commentary` must already be little-text-escaped
 * by the caller. Reads the created post URN from the `x-restli-id` response
 * header and fails LOUD if it's missing (so the run is marked failed, never
 * recorded as posted-with-no-URN → undeletable orphan).
 */
export async function createDocumentPost(
  accessToken: string,
  authorUrn: string,
  commentary: string,
  documentUrn: string,
  title: string,
): Promise<{ postUrn: string; postUrl: string }> {
  const res = await tfetch(`${REST_BASE}/posts`, {
    method: "POST",
    headers: restHeaders(accessToken, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      author: authorUrn,
      commentary,
      visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      content: { media: { title, id: documentUrn } },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    }),
  });
  if (!res.ok && res.status !== 201) throw await toError(res, "post-create");
  const postUrn = res.headers.get("x-restli-id");
  if (!postUrn || !POST_URN_RE.test(postUrn)) {
    throw new LinkedInApiError(
      `[linkedin:post-create] post created but x-restli-id header missing/invalid (${postUrn ?? "null"}) — manual check required`,
      res.status,
    );
  }
  return { postUrn, postUrl: `https://www.linkedin.com/feed/update/${postUrn}/` };
}

export async function deletePost(accessToken: string, postUrn: string): Promise<void> {
  const res = await tfetch(`${REST_BASE}/posts/${encodeURIComponent(postUrn)}`, {
    method: "DELETE",
    headers: restHeaders(accessToken, { "X-RestLi-Method": "DELETE" }),
  });
  // 204 success; treat idempotent re-delete (404) as success too.
  if (res.status === 204 || res.status === 200 || res.status === 404) return;
  throw await toError(res, "post-delete");
}
