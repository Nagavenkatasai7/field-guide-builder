import { NextResponse } from "next/server";
import { listRuns, storageEnabled, type PostFormat, type RepurposeBundle, type ScheduledRunRow, type ScheduledRunStatus } from "@/lib/storage";

export const runtime = "nodejs";
export const maxDuration = 30;

/** Token-free wire shape for the panel. Contains NO linkedin_account fields. */
export type AutomationRunWire = {
  id: string;
  createdAt: string;
  runDate: string;
  trigger: "cron" | "manual";
  status: ScheduledRunStatus;
  dryRun: boolean;
  topic: string | null;
  captionPreview: string | null;
  caption: string | null;
  planTitle: string | null;
  pdfUrl: string | null;
  zipUrl: string | null;
  pageCount: number | null;
  linkedinPostUrl: string | null;
  error: string | null;
  postedAt: string | null;
  repurpose: RepurposeBundle | null;
  format: PostFormat;
};

export type AutomationRunsResponse = { enabled: boolean; runs: AutomationRunWire[] };

function toWire(r: ScheduledRunRow): AutomationRunWire {
  return {
    id: r.id,
    createdAt: r.created_at,
    runDate: r.run_date,
    trigger: r.trigger,
    status: r.status,
    dryRun: r.dry_run,
    topic: r.topic,
    captionPreview: r.caption ? r.caption.slice(0, 280) : null,
    caption: r.caption,
    planTitle: r.plan_title,
    pdfUrl: r.pdf_url,
    zipUrl: r.zip_url,
    pageCount: r.page_count,
    linkedinPostUrl: r.linkedin_post_url,
    error: r.error,
    postedAt: r.posted_at,
    repurpose: r.repurpose_json,
    format: r.post_format,
  };
}

export async function GET() {
  if (!storageEnabled()) {
    return NextResponse.json({ enabled: false, runs: [] } satisfies AutomationRunsResponse);
  }
  const runs = await listRuns(20);
  return NextResponse.json({ enabled: true, runs: runs.map(toWire) } satisfies AutomationRunsResponse);
}
