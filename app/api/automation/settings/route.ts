import { NextResponse } from "next/server";
import { z } from "zod";
import { getAutomationSettings, storageEnabled, updateAutomationSettings, type AutomationSettings } from "@/lib/storage";

export const runtime = "nodejs";

export type AutomationSettingsResponse = {
  storage: boolean;
  enabled: boolean;
  dryRun: boolean;
  approvalMode: boolean;
  postHour: number;
  timezone: string;
  scheduleLabel: string;
};

function toResponse(s: AutomationSettings): AutomationSettingsResponse {
  return {
    storage: true,
    enabled: s.enabled,
    dryRun: s.dry_run,
    approvalMode: s.approval_mode,
    postHour: s.post_hour,
    timezone: s.timezone,
    scheduleLabel: `~${s.post_hour}:00 ${s.timezone.replace("_", " ")}, daily (auto-picks a trending AI/ML topic)`,
  };
}

export async function GET() {
  if (!storageEnabled()) {
    return NextResponse.json({ storage: false, enabled: false, dryRun: true, approvalMode: false, postHour: 9, timezone: "America/New_York", scheduleLabel: "storage not configured" } satisfies AutomationSettingsResponse);
  }
  return NextResponse.json(toResponse(await getAutomationSettings()));
}

const Body = z.object({
  enabled: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  approvalMode: z.boolean().optional(),
  postHour: z.number().int().min(0).max(23).optional(),
  timezone: z.string().min(2).max(64).optional(),
});

// Must match the cron entries in vercel.json ("0 16 * * *" + "0 17 * * *").
const CRON_UTC_HOURS = [16, 17];

/** Local hour in `timezone` when it's `utcHour`:00 on the given date. */
function localHourAt(utcHour: number, timezone: string, date: Date): number {
  const d = new Date(date);
  d.setUTCHours(utcHour, 0, 0, 0);
  const h = parseInt(new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", hour12: false }).format(d), 10);
  return h === 24 ? 0 : h;
}

/**
 * post_hour values the fixed UTC crons can hit in EVERY DST season. Anything
 * else would silently disarm the automation for part of the year — the cron
 * would fire, see the wrong hour, and self-skip forever.
 */
function reachablePostHours(timezone: string): number[] {
  const year = new Date().getUTCFullYear();
  const winter = new Date(Date.UTC(year, 0, 15));
  const summer = new Date(Date.UTC(year, 6, 15));
  const winterHours = new Set(CRON_UTC_HOURS.map((h) => localHourAt(h, timezone, winter)));
  const summerHours = new Set(CRON_UTC_HOURS.map((h) => localHourAt(h, timezone, summer)));
  return [...winterHours].filter((h) => summerHours.has(h));
}

export async function POST(request: Request) {
  if (!storageEnabled()) return NextResponse.json({ error: "Storage not configured" }, { status: 400 });
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host !== new URL(request.url).host) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
    } catch {
      return NextResponse.json({ error: "Bad origin" }, { status: 403 });
    }
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });

  // Validate the EFFECTIVE schedule (patch merged over current settings) so a
  // post_hour/timezone combination the fixed UTC crons can never hit is
  // rejected here instead of silently never firing.
  const current = await getAutomationSettings();
  const timezone = parsed.data.timezone ?? current.timezone;
  const postHour = parsed.data.postHour ?? current.post_hour;
  let reachable: number[];
  try {
    reachable = reachablePostHours(timezone);
  } catch {
    return NextResponse.json({ error: `Unknown timezone: ${timezone}` }, { status: 400 });
  }
  if (!reachable.includes(postHour)) {
    return NextResponse.json(
      { error: `post hour ${postHour} is unreachable for ${timezone} — the fixed UTC crons (${CRON_UTC_HOURS.join(", ")}:00 UTC) can only hit hour(s) ${reachable.join(", ")} year-round. Change vercel.json crons to move the schedule.` },
      { status: 400 },
    );
  }

  const updated = await updateAutomationSettings({
    enabled: parsed.data.enabled,
    dry_run: parsed.data.dryRun,
    approval_mode: parsed.data.approvalMode,
    post_hour: parsed.data.postHour,
    timezone: parsed.data.timezone,
  });
  return NextResponse.json(toResponse(updated));
}
