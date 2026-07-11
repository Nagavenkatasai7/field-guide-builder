import { NextResponse } from "next/server";
import { listAlerts, storageEnabled, type AlertRow } from "@/lib/storage";

export const runtime = "nodejs";

export type AlertWire = {
  id: string;
  createdAt: string;
  kind: string;
  subject: string;
  recipient: string | null;
  status: string;
  detail: string | null;
};

export type AlertsResponse = { enabled: boolean; alerts: AlertWire[] };

function toWire(a: AlertRow): AlertWire {
  return {
    id: a.id,
    createdAt: a.created_at,
    kind: a.kind,
    subject: a.subject,
    recipient: a.recipient,
    status: a.status,
    detail: a.detail,
  };
}

export async function GET() {
  if (!storageEnabled()) return NextResponse.json({ enabled: false, alerts: [] } satisfies AlertsResponse);
  const alerts = await listAlerts(30);
  return NextResponse.json({ enabled: true, alerts: alerts.map(toWire) } satisfies AlertsResponse);
}
