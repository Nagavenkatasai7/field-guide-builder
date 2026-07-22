import { put, type PutBlobResult } from "@vercel/blob";
// `db` is the same VercelPool singleton as `sql`; we use db.query() only in
// updateRun() to build a whitelisted dynamic SET clause (the `sql` tagged
// template can't carry identifiers or jsonb objects).
import { db, sql } from "@vercel/postgres";

export type GenerationRow = {
  id: string;
  created_at: string;
  title: string;
  topic: string;
  source_count: number;
  page_count: number;
  pdf_url: string;
  zip_url: string;
  pdf_bytes: number;
  zip_bytes: number;
  linkedin_chars: number | null;
};

/** True when both Postgres and Blob env vars are configured. */
export function storageEnabled(): boolean {
  return Boolean(process.env.POSTGRES_URL && process.env.BLOB_READ_WRITE_TOKEN);
}

let schemaReady = false;
async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  await sql`
    CREATE TABLE IF NOT EXISTS generations (
      id              text PRIMARY KEY,
      created_at      timestamptz NOT NULL DEFAULT now(),
      title           text NOT NULL,
      topic           text NOT NULL,
      source_count    int NOT NULL,
      page_count      int NOT NULL,
      pdf_url         text NOT NULL,
      zip_url         text NOT NULL,
      pdf_bytes       int NOT NULL,
      zip_bytes       int NOT NULL,
      linkedin_chars  int
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS generations_created_idx ON generations (created_at DESC)`;

  // --- Automation tables (LinkedIn daily auto-post) ---
  // Singleton row (id=1) holding the OAuth secrets. Tokens are secrets at rest
  // in the private Neon DB; never log them and never return access/refresh to
  // the browser (use getLinkedinStatus() for client-facing data).
  await sql`
    CREATE TABLE IF NOT EXISTS linkedin_account (
      id                int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      access_token      text NOT NULL,
      refresh_token     text,
      token_expires_at  timestamptz,
      member_urn        text NOT NULL,
      member_name       text NOT NULL,
      scope             text NOT NULL,
      connected_at      timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now()
    )
  `;

  // The automation system-of-record. One row per run. Idempotency is
  // CRON-SCOPED via a partial unique index so a manual/dry-run never occupies
  // the day's slot (an 8am dry-run must not block the 9am cron).
  await sql`
    CREATE TABLE IF NOT EXISTS scheduled_runs (
      id                 text PRIMARY KEY,
      created_at         timestamptz NOT NULL DEFAULT now(),
      updated_at         timestamptz NOT NULL DEFAULT now(),
      run_date           date NOT NULL,
      trigger            text NOT NULL,          -- 'cron' | 'manual'
      status             text NOT NULL,          -- see ScheduledRunStatus
      dry_run            boolean NOT NULL DEFAULT false,
      topic              text,
      angle              text,
      plan_title         text,
      caption            text,
      pdf_url            text,
      zip_url            text,
      page_count         int,
      source_count       int,
      linkedin_post_urn  text,
      linkedin_post_url  text,
      api_version        text,
      error              text,
      posted_at          timestamptz,
      timings_json       jsonb
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS scheduled_runs_created_idx ON scheduled_runs (created_at DESC)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS scheduled_runs_cron_date ON scheduled_runs (run_date) WHERE trigger = 'cron'`;
  // Same-day auto-retry support (added post-M10; idempotent for existing tables).
  await sql`ALTER TABLE scheduled_runs ADD COLUMN IF NOT EXISTS attempt int NOT NULL DEFAULT 1`;
  // Approval mode (M12). approval_token_hash stores ONLY the HMAC of the
  // emailed capability token (never the token itself); personal_take is the
  // owner's voice-injection text captured on the approval page.
  await sql`ALTER TABLE scheduled_runs ADD COLUMN IF NOT EXISTS approval_token_hash text`;
  await sql`ALTER TABLE scheduled_runs ADD COLUMN IF NOT EXISTS approval_expires_at timestamptz`;
  await sql`ALTER TABLE scheduled_runs ADD COLUMN IF NOT EXISTS personal_take text`;
  // Repurposing engine (M14): blog/thread/newsletter derivatives of a posted
  // guide, generated on demand and stored as one JSON blob.
  await sql`ALTER TABLE scheduled_runs ADD COLUMN IF NOT EXISTS repurpose_json jsonb`;

  // Singleton automation settings. Defaults are SAFE: automation OFF and
  // dry_run ON until the user explicitly enables it (default-off rollout).
  await sql`
    CREATE TABLE IF NOT EXISTS automation_settings (
      id             int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      enabled        boolean NOT NULL DEFAULT false,
      dry_run        boolean NOT NULL DEFAULT true,
      approval_mode  boolean NOT NULL DEFAULT false,
      post_hour      int NOT NULL DEFAULT 12,
      timezone       text NOT NULL DEFAULT 'America/New_York',
      updated_at     timestamptz NOT NULL DEFAULT now()
    )
  `;
  await sql`ALTER TABLE automation_settings ADD COLUMN IF NOT EXISTS approval_mode boolean NOT NULL DEFAULT false`;

  // Engagement cockpit (M13): daily suggestions of posts/articles worth a
  // manual comment, each with an LLM-drafted comment the owner copies by hand.
  // Deliberately NO automation of the LinkedIn action itself (ToS).
  await sql`
    CREATE TABLE IF NOT EXISTS engagement_items (
      id             text PRIMARY KEY,
      created_at     timestamptz NOT NULL DEFAULT now(),
      item_date      date NOT NULL,
      url            text NOT NULL,
      title          text NOT NULL,
      snippet        text,
      source         text NOT NULL,     -- 'linkedin' | 'article'
      draft_comment  text NOT NULL,
      status         text NOT NULL DEFAULT 'fresh'  -- 'fresh' | 'used' | 'dismissed'
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS engagement_items_date_idx ON engagement_items (item_date DESC, created_at DESC)`;

  // Log of out-of-band alerts (emails) so they're visible in the dashboard.
  await sql`
    CREATE TABLE IF NOT EXISTS alerts (
      id          text PRIMARY KEY,
      created_at  timestamptz NOT NULL DEFAULT now(),
      kind        text NOT NULL,
      subject     text NOT NULL,
      recipient   text,
      status      text NOT NULL,    -- 'sent' | 'failed' | 'dormant'
      run_id      text,
      detail      text
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS alerts_created_idx ON alerts (created_at DESC)`;

  schemaReady = true;
}

export async function uploadBlob(
  pathname: string,
  body: Buffer,
  contentType: string,
  opts?: { addRandomSuffix?: boolean; allowOverwrite?: boolean },
): Promise<PutBlobResult> {
  return await put(pathname, body, {
    access: "public",
    contentType,
    // Automation path passes addRandomSuffix:true so PDFs of blocked/failed
    // (never-posted) runs get high-entropy, unguessable URLs. Posted PDFs are
    // public by design — LinkedIn serves them.
    addRandomSuffix: opts?.addRandomSuffix ?? false,
    allowOverwrite: opts?.allowOverwrite ?? false,
  });
}

export async function recordGeneration(input: Omit<GenerationRow, "created_at">): Promise<void> {
  await ensureSchema();
  await sql`
    INSERT INTO generations
      (id, title, topic, source_count, page_count, pdf_url, zip_url, pdf_bytes, zip_bytes, linkedin_chars)
    VALUES
      (${input.id}, ${input.title}, ${input.topic}, ${input.source_count}, ${input.page_count},
       ${input.pdf_url}, ${input.zip_url}, ${input.pdf_bytes}, ${input.zip_bytes}, ${input.linkedin_chars})
  `;
}

export async function listGenerations(limit = 20): Promise<GenerationRow[]> {
  await ensureSchema();
  const result = await sql<GenerationRow>`
    SELECT id, created_at::text, title, topic, source_count, page_count,
           pdf_url, zip_url, pdf_bytes, zip_bytes, linkedin_chars
    FROM generations
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return result.rows;
}

/** Builds a short id that's safe for use in URLs/filenames. */
export function newRunId(): string {
  const ts = Date.now().toString(36);
  const rnd = (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10));
  return `${ts}-${rnd}`;
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "field-guide";
}

// ============================================================================
// Automation: LinkedIn account, scheduled runs, settings
// ============================================================================

export type LinkedinAccountRow = {
  id: number;
  access_token: string;
  refresh_token: string | null;
  token_expires_at: string | null;
  member_urn: string;
  member_name: string;
  scope: string;
  connected_at: string;
  updated_at: string;
};

/** Token-free projection — the ONLY linkedin_account shape safe to send to the browser. */
export type LinkedinStatus =
  | { connected: false }
  | {
      connected: true;
      memberName: string;
      scope: string;
      connectedAt: string;
      tokenExpiresAt: string | null;
      daysLeft: number | null;
    };

export type ScheduledRunStatus =
  | "claimed"
  | "generating"
  | "generated"
  | "blocked"
  | "uploading"
  | "dry_run"
  | "awaiting_approval" // approval mode: generated + gated, parked for the owner's decision
  | "approved"          // decide route claimed it; publishing is in flight (pre-post)
  | "posting"
  | "posted"
  | "failed"
  | "needs_review"
  | "skipped"
  | "deleted";

export type ScheduledRunRow = {
  id: string;
  created_at: string;
  updated_at: string;
  run_date: string;
  trigger: "cron" | "manual";
  status: ScheduledRunStatus;
  dry_run: boolean;
  topic: string | null;
  angle: string | null;
  plan_title: string | null;
  caption: string | null;
  pdf_url: string | null;
  zip_url: string | null;
  page_count: number | null;
  source_count: number | null;
  linkedin_post_urn: string | null;
  linkedin_post_url: string | null;
  api_version: string | null;
  error: string | null;
  posted_at: string | null;
  timings_json: Record<string, number> | null;
  // approval_token_hash is an HMAC (useless without AUTH_COOKIE_SECRET), but
  // still: never map it into a wire type. personal_take is owner-authored.
  approval_token_hash: string | null;
  approval_expires_at: string | null;
  personal_take: string | null;
  repurpose_json: RepurposeBundle | null;
};

/** Derivatives of a posted guide for owned channels (blog, X, newsletter). */
export type RepurposeBundle = {
  blog_markdown: string;
  x_thread: string[];
  newsletter_markdown: string;
  generated_at: string;
};

export type AutomationSettings = {
  enabled: boolean;
  dry_run: boolean;
  approval_mode: boolean;
  post_hour: number;
  timezone: string;
  updated_at: string | null;
};

// --- linkedin_account ---

/** Full row incl. tokens — SERVER-INTERNAL ONLY. Never return to the browser. */
export async function getLinkedinAccount(): Promise<LinkedinAccountRow | null> {
  await ensureSchema();
  const res = await sql<LinkedinAccountRow>`
    SELECT id, access_token, refresh_token, token_expires_at::text, member_urn, member_name,
           scope, connected_at::text, updated_at::text
    FROM linkedin_account WHERE id = 1
  `;
  return res.rows[0] ?? null;
}

/** Client-safe status (no tokens). Computes days-until-expiry for the UI warning. */
export async function getLinkedinStatus(): Promise<LinkedinStatus> {
  await ensureSchema();
  const res = await sql<{ member_name: string; scope: string; connected_at: string; token_expires_at: string | null }>`
    SELECT member_name, scope, connected_at::text, token_expires_at::text
    FROM linkedin_account WHERE id = 1
  `;
  const row = res.rows[0];
  if (!row) return { connected: false };
  let daysLeft: number | null = null;
  if (row.token_expires_at) {
    const ms = new Date(row.token_expires_at).getTime() - Date.now();
    daysLeft = Math.floor(ms / 86_400_000);
  }
  return {
    connected: true,
    memberName: row.member_name,
    scope: row.scope,
    connectedAt: row.connected_at,
    tokenExpiresAt: row.token_expires_at,
    daysLeft,
  };
}

export async function upsertLinkedinAccount(input: {
  access_token: string;
  refresh_token: string | null;
  token_expires_at: string | null;
  member_urn: string;
  member_name: string;
  scope: string;
}): Promise<void> {
  await ensureSchema();
  await sql`
    INSERT INTO linkedin_account
      (id, access_token, refresh_token, token_expires_at, member_urn, member_name, scope)
    VALUES
      (1, ${input.access_token}, ${input.refresh_token}, ${input.token_expires_at},
       ${input.member_urn}, ${input.member_name}, ${input.scope})
    ON CONFLICT (id) DO UPDATE SET
      access_token = EXCLUDED.access_token,
      refresh_token = EXCLUDED.refresh_token,
      token_expires_at = EXCLUDED.token_expires_at,
      member_urn = EXCLUDED.member_urn,
      member_name = EXCLUDED.member_name,
      scope = EXCLUDED.scope,
      updated_at = now()
  `;
}

/** Used by the token-refresh path: rotate tokens without touching member identity. */
export async function updateLinkedinTokens(input: {
  access_token: string;
  refresh_token: string | null;
  token_expires_at: string | null;
}): Promise<void> {
  await ensureSchema();
  await sql`
    UPDATE linkedin_account SET
      access_token = ${input.access_token},
      refresh_token = COALESCE(${input.refresh_token}, refresh_token),
      token_expires_at = ${input.token_expires_at},
      updated_at = now()
    WHERE id = 1
  `;
}

export async function clearLinkedinAccount(): Promise<void> {
  await ensureSchema();
  await sql`DELETE FROM linkedin_account WHERE id = 1`;
}

// --- scheduled_runs ---

const SCHEDULED_RUN_COLUMNS = `
  id, created_at::text, updated_at::text, run_date::text, trigger, status, dry_run,
  topic, angle, plan_title, caption, pdf_url, zip_url, page_count, source_count,
  linkedin_post_urn, linkedin_post_url, api_version, error, posted_at::text, timings_json,
  approval_token_hash, approval_expires_at::text, personal_take, repurpose_json
`;

/**
 * Claims a run. For 'cron', enforces one-per-day via the partial unique index
 * (returns claimed=false if today is already taken — the second cron fire / a
 * concurrent invocation). For 'manual', always inserts (dry-runs and manual
 * tests never occupy the daily cron slot, so they can't block the 9am cron).
 */
export async function claimRun(
  runDate: string,
  trigger: "cron" | "manual",
  dryRun: boolean,
): Promise<{ claimed: boolean; id: string }> {
  await ensureSchema();
  const id = newRunId();
  if (trigger === "cron") {
    const res = await sql`
      INSERT INTO scheduled_runs (id, run_date, trigger, status, dry_run)
      VALUES (${id}, ${runDate}, 'cron', 'claimed', ${dryRun})
      ON CONFLICT (run_date) WHERE trigger = 'cron' DO NOTHING
      RETURNING id
    `;
    return { claimed: res.rowCount === 1, id };
  }
  await sql`
    INSERT INTO scheduled_runs (id, run_date, trigger, status, dry_run)
    VALUES (${id}, ${runDate}, 'manual', 'claimed', ${dryRun})
  `;
  return { claimed: true, id };
}

/**
 * Atomically re-claims today's cron run for a same-day retry — ONLY from the
 * safely-retryable terminal states. 'failed' here always means a pre-post
 * stage (post-call failures become 'needs_review'), and 'blocked' is always
 * pre-post by construction, so regenerating is safe. 'posting' / 'posted' /
 * 'needs_review' / 'dry_run' are never touched. The attempt cap stops loops.
 */
export async function reclaimRetryableCronRun(
  runDate: string,
  maxAttempts = 3,
): Promise<{ id: string; attempt: number } | null> {
  await ensureSchema();
  const res = await sql<{ id: string; attempt: number }>`
    UPDATE scheduled_runs
    SET status = 'claimed', error = NULL, attempt = attempt + 1, updated_at = now()
    WHERE run_date = ${runDate} AND trigger = 'cron'
      AND status IN ('failed', 'blocked')
      AND attempt < ${maxAttempts}
    RETURNING id, attempt
  `;
  return res.rows[0] ?? null;
}

const SCHEDULED_RUN_UPDATABLE = [
  "status", "topic", "angle", "plan_title", "caption", "pdf_url", "zip_url",
  "page_count", "source_count", "linkedin_post_urn", "linkedin_post_url",
  "api_version", "error", "posted_at", "timings_json",
  "approval_token_hash", "approval_expires_at", "personal_take", "repurpose_json",
] as const;

export type ScheduledRunPatch = Partial<Pick<ScheduledRunRow, (typeof SCHEDULED_RUN_UPDATABLE)[number]>>;

/**
 * Whitelisted dynamic UPDATE. Column names come ONLY from the const tuple
 * SCHEDULED_RUN_UPDATABLE (never Object.keys(patch)), so the dynamically-built
 * SET clause is injection-safe; values always travel as bind params. Present-
 * key semantics (not value-truthiness) let `error: null` clear a column on
 * retry — which a COALESCE-per-column approach cannot.
 */
export async function updateRun(id: string, patch: ScheduledRunPatch): Promise<void> {
  await ensureSchema();
  const sets: string[] = [];
  const params: (string | number | boolean | null)[] = [];
  let n = 1;
  for (const col of SCHEDULED_RUN_UPDATABLE) {
    const value = (patch as Record<string, unknown>)[col];
    if (!(col in patch) || value === undefined) continue;
    if (col === "timings_json" || col === "repurpose_json") {
      sets.push(`"${col}" = $${n}::jsonb`);
      params.push(value == null ? null : JSON.stringify(value));
    } else {
      sets.push(`"${col}" = $${n}`);
      params.push((value ?? null) as string | number | boolean | null);
    }
    n++;
  }
  if (sets.length === 0) return;
  sets.push("updated_at = now()");
  params.push(id);
  await db.query(`UPDATE scheduled_runs SET ${sets.join(", ")} WHERE id = $${n}`, params);
}

export async function listRuns(limit = 20): Promise<ScheduledRunRow[]> {
  await ensureSchema();
  const res = await db.query<ScheduledRunRow>(
    `SELECT ${SCHEDULED_RUN_COLUMNS} FROM scheduled_runs ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return res.rows;
}

/** Posted runs only — the public feed's source. Everything here is already
 * public by construction (it's live on LinkedIn). */
export async function listPostedRuns(limit = 50): Promise<ScheduledRunRow[]> {
  await ensureSchema();
  const res = await db.query<ScheduledRunRow>(
    `SELECT ${SCHEDULED_RUN_COLUMNS} FROM scheduled_runs
     WHERE status = 'posted' ORDER BY posted_at DESC NULLS LAST LIMIT $1`,
    [limit],
  );
  return res.rows;
}

export async function getRun(id: string): Promise<ScheduledRunRow | null> {
  await ensureSchema();
  const res = await db.query<ScheduledRunRow>(
    `SELECT ${SCHEDULED_RUN_COLUMNS} FROM scheduled_runs WHERE id = $1`,
    [id],
  );
  return res.rows[0] ?? null;
}

/** Recent picked topics for the daily auto-pick dedupe. Source of truth is the
 * topic written at pick time (NOT generations.topic, which is the subtitle). */
export async function recentTopics(n = 30): Promise<string[]> {
  await ensureSchema();
  const res = await sql<{ topic: string }>`
    SELECT topic FROM scheduled_runs
    WHERE topic IS NOT NULL
    ORDER BY created_at DESC LIMIT ${n}
  `;
  return res.rows.map((r) => r.topic);
}

/**
 * Reaps runs left non-terminal by a killed invocation (Vercel maxDuration is
 * 300s, so anything idle longer than 15 min is certainly dead). Pre-post
 * stages ('approved' included — the decide route dies before 'posting') are
 * safely retryable → 'failed'. A stale 'posting' MIGHT have reached LinkedIn
 * (we can't read it back — r_member_social is gated), so it becomes
 * 'needs_review' and is NEVER auto-reposted. Returns ids set to needs_review
 * so the caller can alert.
 *
 * Staleness is measured on updated_at, NOT created_at: approval mode parks a
 * run for hours, so an approve that flips it to 'approved'/'posting' at 6pm
 * must not be reaped by a concurrent cron fire just because the row was
 * CREATED at noon. Every legitimate transition bumps updated_at.
 */
export async function reapStaleRuns(): Promise<{ failed: string[]; needsReview: string[] }> {
  await ensureSchema();
  const failedRes = await sql<{ id: string }>`
    UPDATE scheduled_runs
    SET status = 'failed', error = COALESCE(error, 'reaped: invocation died before completing (pre-post stage)'), updated_at = now()
    WHERE status IN ('claimed', 'generating', 'generated', 'uploading', 'approved')
      AND updated_at < now() - interval '15 minutes'
    RETURNING id
  `;
  const res = await sql<{ id: string }>`
    UPDATE scheduled_runs
    SET status = 'needs_review', error = COALESCE(error, 'reaped: died while posting — may have posted to LinkedIn; manual check required'), updated_at = now()
    WHERE status = 'posting'
      AND updated_at < now() - interval '15 minutes'
    RETURNING id
  `;
  // Approval windows that lapsed with no decision → quiet 'skipped'. Nothing
  // was posted; the run stays reviewable in the dashboard. The hash is cleared
  // so an old emailed link can never act on the (now terminal) row.
  await sql`
    UPDATE scheduled_runs
    SET status = 'skipped', error = 'approval window expired — nothing was posted', approval_token_hash = NULL, updated_at = now()
    WHERE status = 'awaiting_approval'
      AND approval_expires_at IS NOT NULL AND approval_expires_at < now()
  `;
  return { failed: failedRes.rows.map((r) => r.id), needsReview: res.rows.map((r) => r.id) };
}

/**
 * Atomically claims an awaiting_approval run for a decision. All guards live
 * in the WHERE clause so a double-click / two-device race resolves to exactly
 * one winner: status must still be awaiting_approval, the presented token's
 * hash must match the stored one (binds the decision to the newest issued
 * link), and the window must not have lapsed. Clearing the hash makes the
 * token single-use. Returns false when any guard fails (caller → 409).
 */
export async function claimApprovalDecision(input: {
  id: string;
  tokenHash: string;
  decision: "approved" | "skipped";
  finalCaption?: string;
  personalTake?: string | null;
}): Promise<boolean> {
  await ensureSchema();
  if (input.decision === "approved") {
    const res = await sql`
      UPDATE scheduled_runs
      SET status = 'approved', caption = ${input.finalCaption ?? null},
          personal_take = ${input.personalTake ?? null},
          approval_token_hash = NULL, updated_at = now()
      WHERE id = ${input.id} AND status = 'awaiting_approval'
        AND approval_token_hash = ${input.tokenHash}
        AND (approval_expires_at IS NULL OR approval_expires_at > now())
      RETURNING id
    `;
    return res.rowCount === 1;
  }
  const res = await sql`
    UPDATE scheduled_runs
    SET status = 'skipped', error = 'skipped by owner from the approval page',
        approval_token_hash = NULL, updated_at = now()
    WHERE id = ${input.id} AND status = 'awaiting_approval'
      AND approval_token_hash = ${input.tokenHash}
      AND (approval_expires_at IS NULL OR approval_expires_at > now())
    RETURNING id
  `;
  return res.rowCount === 1;
}

/** Today's cron run row (if any) — used by the off-hour dead-man's-switch. */
export async function getCronRunForDate(runDate: string): Promise<ScheduledRunRow | null> {
  await ensureSchema();
  const res = await db.query<ScheduledRunRow>(
    `SELECT ${SCHEDULED_RUN_COLUMNS} FROM scheduled_runs WHERE run_date = $1 AND trigger = 'cron' LIMIT 1`,
    [runDate],
  );
  return res.rows[0] ?? null;
}

// --- automation_settings ---

export async function getAutomationSettings(): Promise<AutomationSettings> {
  await ensureSchema();
  const res = await sql<{ enabled: boolean; dry_run: boolean; approval_mode: boolean; post_hour: number; timezone: string; updated_at: string }>`
    SELECT enabled, dry_run, approval_mode, post_hour, timezone, updated_at::text FROM automation_settings WHERE id = 1
  `;
  const row = res.rows[0];
  if (!row) {
    // Safe defaults before the user ever opens settings: OFF + dry-run ON.
    return { enabled: false, dry_run: true, approval_mode: false, post_hour: 12, timezone: "America/New_York", updated_at: null };
  }
  return row;
}

// --- engagement_items (M13 cockpit) ---

export type EngagementItemRow = {
  id: string;
  created_at: string;
  item_date: string;
  url: string;
  title: string;
  snippet: string | null;
  source: "linkedin" | "article";
  draft_comment: string;
  status: "fresh" | "used" | "dismissed";
};

export async function insertEngagementItems(
  itemDate: string,
  items: Array<{ url: string; title: string; snippet: string | null; source: "linkedin" | "article"; draft_comment: string }>,
): Promise<void> {
  await ensureSchema();
  for (const it of items) {
    await sql`
      INSERT INTO engagement_items (id, item_date, url, title, snippet, source, draft_comment)
      VALUES (${newRunId()}, ${itemDate}, ${it.url}, ${it.title}, ${it.snippet}, ${it.source}, ${it.draft_comment})
    `;
  }
}

export async function listEngagementItems(itemDate: string): Promise<EngagementItemRow[]> {
  await ensureSchema();
  const res = await sql<EngagementItemRow>`
    SELECT id, created_at::text, item_date::text, url, title, snippet, source, draft_comment, status
    FROM engagement_items WHERE item_date = ${itemDate}
    ORDER BY source DESC, created_at ASC
  `;
  return res.rows;
}

/** URLs suggested recently — the finder filters these so the cockpit never
 * re-suggests something the owner already engaged with (or dismissed). */
export async function recentEngagementUrls(days = 14): Promise<string[]> {
  await ensureSchema();
  const res = await sql<{ url: string }>`
    SELECT DISTINCT url FROM engagement_items
    WHERE created_at > now() - make_interval(days => ${days})
  `;
  return res.rows.map((r) => r.url);
}

export async function setEngagementItemStatus(id: string, status: "fresh" | "used" | "dismissed"): Promise<boolean> {
  await ensureSchema();
  const res = await sql`
    UPDATE engagement_items SET status = ${status} WHERE id = ${id} RETURNING id
  `;
  return res.rowCount === 1;
}

// --- alerts (email log) ---

export type AlertRow = {
  id: string;
  created_at: string;
  kind: string;
  subject: string;
  recipient: string | null;
  status: string;
  run_id: string | null;
  detail: string | null;
};

export async function recordAlert(input: {
  kind: string;
  subject: string;
  recipient?: string | null;
  status: string;
  run_id?: string | null;
  detail?: string | null;
}): Promise<void> {
  await ensureSchema();
  await sql`
    INSERT INTO alerts (id, kind, subject, recipient, status, run_id, detail)
    VALUES (${newRunId()}, ${input.kind}, ${input.subject}, ${input.recipient ?? null},
            ${input.status}, ${input.run_id ?? null}, ${input.detail ?? null})
  `;
}

export async function listAlerts(limit = 30): Promise<AlertRow[]> {
  await ensureSchema();
  const res = await sql<AlertRow>`
    SELECT id, created_at::text, kind, subject, recipient, status, run_id, detail
    FROM alerts ORDER BY created_at DESC LIMIT ${limit}
  `;
  return res.rows;
}

export async function updateAutomationSettings(patch: {
  enabled?: boolean;
  dry_run?: boolean;
  approval_mode?: boolean;
  post_hour?: number;
  timezone?: string;
}): Promise<AutomationSettings> {
  await ensureSchema();
  const res = await sql<{ enabled: boolean; dry_run: boolean; approval_mode: boolean; post_hour: number; timezone: string; updated_at: string }>`
    INSERT INTO automation_settings (id, enabled, dry_run, approval_mode, post_hour, timezone)
    VALUES (
      1,
      COALESCE(${patch.enabled ?? null}, false),
      COALESCE(${patch.dry_run ?? null}, true),
      COALESCE(${patch.approval_mode ?? null}, false),
      COALESCE(${patch.post_hour ?? null}, 12),
      COALESCE(${patch.timezone ?? null}, 'America/New_York')
    )
    ON CONFLICT (id) DO UPDATE SET
      enabled = COALESCE(${patch.enabled ?? null}, automation_settings.enabled),
      dry_run = COALESCE(${patch.dry_run ?? null}, automation_settings.dry_run),
      approval_mode = COALESCE(${patch.approval_mode ?? null}, automation_settings.approval_mode),
      post_hour = COALESCE(${patch.post_hour ?? null}, automation_settings.post_hour),
      timezone = COALESCE(${patch.timezone ?? null}, automation_settings.timezone),
      updated_at = now()
    RETURNING enabled, dry_run, approval_mode, post_hour, timezone, updated_at::text
  `;
  return res.rows[0];
}
