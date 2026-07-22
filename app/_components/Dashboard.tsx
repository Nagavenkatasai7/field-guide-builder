"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import EngagePanel from "@/app/_components/EngagePanel";
import GenerateWorkspace from "@/app/_components/GenerateWorkspace";
import HistoryPanel from "@/app/_components/HistoryPanel";
import type { LinkedinStatus } from "@/lib/storage";
import type { AutomationSettingsResponse } from "@/app/api/automation/settings/route";
import type { AutomationRunsResponse, AutomationRunWire } from "@/app/api/automation/runs/route";
import type { AlertsResponse, AlertWire } from "@/app/api/automation/alerts/route";

type TabKey = "overview" | "posts" | "engage" | "history" | "alerts" | "generate" | "settings";
const TABS: { key: TabKey; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "posts", label: "Posts" },
  { key: "engage", label: "Engage" },
  { key: "history", label: "History" },
  { key: "alerts", label: "Alerts" },
  { key: "generate", label: "Generate" },
  { key: "settings", label: "Settings" },
];

const ACTIVE_STATUSES = new Set(["claimed", "generating", "generated", "uploading", "approved", "posting"]);

const BADGE: Record<string, { label: string; cls: string }> = {
  claimed: { label: "Queued", cls: "bg-amber-100 text-amber-800" },
  generating: { label: "Generating", cls: "bg-amber-100 text-amber-800" },
  generated: { label: "Generated", cls: "bg-amber-100 text-amber-800" },
  uploading: { label: "Uploading", cls: "bg-amber-100 text-amber-800" },
  awaiting_approval: { label: "Awaiting approval", cls: "bg-purple-100 text-purple-800" },
  approved: { label: "Approved — posting", cls: "bg-amber-100 text-amber-800" },
  posting: { label: "Posting", cls: "bg-amber-100 text-amber-800" },
  posted: { label: "Posted", cls: "bg-green-100 text-green-800" },
  dry_run: { label: "Dry-run", cls: "bg-indigo-100 text-indigo-800" },
  blocked: { label: "Blocked (safe)", cls: "bg-yellow-100 text-yellow-900" },
  failed: { label: "Failed", cls: "bg-red-100 text-red-800" },
  needs_review: { label: "Needs review", cls: "bg-orange-200 text-orange-900" },
  deleted: { label: "Deleted", cls: "bg-gray-100 text-gray-500 line-through" },
  skipped: { label: "Skipped", cls: "bg-gray-100 text-gray-600" },
};

const ALERT_BADGE: Record<string, string> = {
  sent: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
  dormant: "bg-gray-100 text-gray-600",
};

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " +
      d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

export default function Dashboard() {
  const router = useRouter();
  const [tab, setTab] = useState<TabKey>("overview");
  const [status, setStatus] = useState<LinkedinStatus | null>(null);
  const [settings, setSettings] = useState<AutomationSettingsResponse | null>(null);
  const [runs, setRuns] = useState<AutomationRunWire[]>([]);
  const [alerts, setAlerts] = useState<AlertWire[]>([]);
  const [storageOff, setStorageOff] = useState(false);
  const [busyToggle, setBusyToggle] = useState(false);
  const [busyRunNow, setBusyRunNow] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, st, r, a] = await Promise.all([
        fetch("/api/linkedin/status", { cache: "no-store" }).then((x) => x.json() as Promise<LinkedinStatus>),
        fetch("/api/automation/settings", { cache: "no-store" }).then((x) => x.json() as Promise<AutomationSettingsResponse>),
        fetch("/api/automation/runs", { cache: "no-store" }).then((x) => x.json() as Promise<AutomationRunsResponse>),
        fetch("/api/automation/alerts", { cache: "no-store" }).then((x) => x.json() as Promise<AlertsResponse>),
      ]);
      setStatus(s);
      setSettings(st);
      setRuns(r.runs ?? []);
      setAlerts(a.alerts ?? []);
      setStorageOff(!st.storage);
    } catch {
      /* transient; next poll/refresh recovers */
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get("linkedin");
    if (!p) return;
    const map: Record<string, string> = {
      connected: "✅ LinkedIn connected.",
      denied: "You declined the LinkedIn authorization.",
      csrf_error: "LinkedIn connect failed a security check — try again.",
      exchange_error: "LinkedIn connect failed during token exchange — check your app credentials.",
      config_error: "LINKEDIN_REDIRECT_URI is not configured.",
    };
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBanner(map[p] ?? null);
    window.history.replaceState({}, "", window.location.pathname);
  }, []);

  const hasActive = busyRunNow || runs.some((r) => ACTIVE_STATUSES.has(r.status));
  useEffect(() => {
    if (!hasActive) return;
    const id = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(id);
  }, [hasActive, load]);

  async function toggle(field: "enabled" | "dryRun" | "approvalMode", value: boolean) {
    setBusyToggle(true);
    try {
      const res = await fetch("/api/automation/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });
      if (res.ok) setSettings((await res.json()) as AutomationSettingsResponse);
    } finally {
      setBusyToggle(false);
    }
  }

  async function runNow(dryRun: boolean) {
    setBusyRunNow(true);
    setBanner(dryRun ? "Generating a dry-run… ~1–2 minutes." : "Generating and posting… ~1–2 minutes.");
    try {
      await fetch("/api/automation/run-now", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dryRun }),
      });
    } catch { /* surfaced in the log */ }
    await load();
    setBusyRunNow(false);
    setBanner(null);
  }

  async function disconnect() {
    if (!window.confirm("Disconnect LinkedIn? Daily posting stops until you reconnect.")) return;
    await fetch("/api/linkedin/disconnect", { method: "POST" });
    await load();
  }

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  const connected = status?.connected === true;

  return (
    <main className="min-h-screen px-6 py-8 max-w-6xl mx-auto">
      {/* Masthead */}
      <header className="border-b border-black/10 pb-4 mb-5">
        <div className="flex items-baseline justify-between gap-4 flex-wrap">
          <div>
            <p className="text-[11px] uppercase tracking-[0.25em] text-[var(--color-mute)]">Field Guide Builder · Console</p>
            <h1 className="font-serif text-4xl leading-tight mt-1">Automation dashboard</h1>
          </div>
          <div className="flex items-center gap-4">
            <button type="button" onClick={() => void load()} className="text-xs text-[var(--color-mute)] hover:text-[var(--color-text-body)] underline">Refresh</button>
            <button type="button" onClick={signOut} className="text-xs text-[var(--color-mute)] hover:text-[var(--color-text-body)] underline">Sign out</button>
          </div>
        </div>
      </header>

      {banner ? <p className="text-sm mb-4 px-3 py-2 rounded bg-amber-50 text-amber-900 border border-amber-200">{banner}</p> : null}

      {storageOff ? (
        <p className="text-sm text-[var(--color-mute)] mb-4">Storage (Postgres + Blob) isn’t configured, so automation features are limited.</p>
      ) : null}

      {/* Status strip */}
      <StatusStrip status={status} settings={settings} runs={runs} />

      {/* Tab nav */}
      <nav className="flex gap-1 border-b border-black/10 mb-6 overflow-x-auto">
        {TABS.map((t) => {
          const active = tab === t.key;
          const count = t.key === "posts" ? runs.length : t.key === "alerts" ? alerts.length : null;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`px-3 py-2 text-sm whitespace-nowrap border-b-2 -mb-px transition ${
                active
                  ? "border-[var(--color-amber)] text-[var(--color-text-body)] font-medium"
                  : "border-transparent text-[var(--color-mute)] hover:text-[var(--color-text-body)]"
              }`}
            >
              {t.label}
              {count != null && count > 0 ? <span className="ml-1.5 text-[10px] text-[var(--color-mute)]">{count}</span> : null}
            </button>
          );
        })}
      </nav>

      {tab === "overview" ? (
        <OverviewTab
          status={status} settings={settings} runs={runs} alerts={alerts} connected={connected}
          busyRunNow={busyRunNow} onRunNow={runNow} goTo={setTab}
        />
      ) : null}
      {tab === "posts" ? <PostsTab runs={runs} onChanged={load} /> : null}
      {tab === "engage" ? <EngagePanel /> : null}
      {tab === "history" ? <HistoryPanel /> : null}
      {tab === "alerts" ? <AlertsTab alerts={alerts} /> : null}
      {tab === "generate" ? <GenerateWorkspace /> : null}
      {tab === "settings" ? (
        <SettingsTab
          status={status} settings={settings} connected={connected}
          busyToggle={busyToggle} busyRunNow={busyRunNow}
          onToggle={toggle} onRunNow={runNow} onDisconnect={disconnect}
        />
      ) : null}
    </main>
  );
}

function StatusStrip({ status, settings, runs }: { status: LinkedinStatus | null; settings: AutomationSettingsResponse | null; runs: AutomationRunWire[] }) {
  const connected = status?.connected === true;
  const posted = runs.filter((r) => r.status === "posted").length;
  const blocked = runs.filter((r) => r.status === "blocked").length;
  const failed = runs.filter((r) => r.status === "failed" || r.status === "needs_review").length;

  let tone = "bg-gray-100 text-gray-700 border-gray-200";
  let text = "⏸ Paused";
  if (!connected) { text = "🔌 LinkedIn not connected"; }
  else if (!settings?.enabled) { text = "⏸ Paused — connected"; }
  else if (settings?.dryRun) { tone = "bg-indigo-50 text-indigo-900 border-indigo-200"; text = "🟡 Dry-run (generates, doesn't post)"; }
  else if (settings?.approvalMode) { tone = "bg-purple-50 text-purple-900 border-purple-200"; text = "🟣 Live — posts wait for your approval"; }
  else { tone = "bg-green-50 text-green-900 border-green-200"; text = "🟢 Live — auto-posting"; }

  return (
    <div className="grid gap-3 sm:grid-cols-[1.4fr_1fr_1fr_1fr] mb-6">
      <div className={`rounded-lg border px-4 py-3 ${tone}`}>
        <p className="text-[10px] uppercase tracking-wider opacity-70">Status</p>
        <p className="text-sm font-medium mt-0.5">{text}</p>
        <p className="text-xs opacity-80 mt-1">{settings ? settings.scheduleLabel.split(",")[0].replace("~", "~ ") : ""}</p>
      </div>
      <StatCard label="Posted" value={posted} />
      <StatCard label="Blocked (safe)" value={blocked} />
      <StatCard label="Failed / review" value={failed} />
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-black/5 bg-white px-4 py-3">
      <p className="text-[10px] uppercase tracking-wider text-[var(--color-mute)]">{label}</p>
      <p className="font-serif text-3xl mt-0.5 tabular-nums">{value}</p>
    </div>
  );
}

function OverviewTab({
  status, settings, runs, alerts, connected, busyRunNow, onRunNow, goTo,
}: {
  status: LinkedinStatus | null; settings: AutomationSettingsResponse | null;
  runs: AutomationRunWire[]; alerts: AlertWire[]; connected: boolean;
  busyRunNow: boolean; onRunNow: (dryRun: boolean) => void; goTo: (t: TabKey) => void;
}) {
  const lastPosted = runs.find((r) => r.status === "posted" && r.linkedinPostUrl);
  const daysLeft = connected && status?.connected ? status.daysLeft : null;
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="bg-white rounded-lg border border-black/5 p-5">
        <h2 className="font-serif text-xl mb-2">At a glance</h2>
        <ul className="text-sm grid gap-2">
          <li className="flex justify-between gap-3"><span className="text-[var(--color-mute)]">LinkedIn</span><span>{connected && status?.connected ? `Connected — ${status.memberName}` : "Not connected"}</span></li>
          {daysLeft != null ? <li className="flex justify-between gap-3"><span className="text-[var(--color-mute)]">Token</span><span className={daysLeft <= 7 ? "text-amber-700" : ""}>{daysLeft <= 0 ? "Expired — reconnect" : `~${daysLeft} days left`}</span></li> : null}
          <li className="flex justify-between gap-3"><span className="text-[var(--color-mute)]">Schedule</span><span>{settings?.scheduleLabel.split(",")[0].replace("~", "~ ") ?? "—"}</span></li>
          <li className="flex justify-between gap-3"><span className="text-[var(--color-mute)]">Mode</span><span>{!settings?.enabled ? "Paused" : settings?.dryRun ? "Dry-run" : settings?.approvalMode ? "Live (approval required)" : "Live"}</span></li>
        </ul>
        <div className="flex items-center gap-3 mt-4 flex-wrap">
          <button type="button" onClick={() => onRunNow(true)} disabled={busyRunNow} className="text-sm bg-[var(--color-ink)] text-[var(--color-cream)] px-3 py-1.5 rounded disabled:opacity-50">{busyRunNow ? "Running…" : "Run now (dry-run)"}</button>
          <button type="button" onClick={() => onRunNow(false)} disabled={busyRunNow || !connected} className="text-sm bg-[var(--color-amber)] text-[var(--color-ink)] px-3 py-1.5 rounded font-medium disabled:opacity-50">{busyRunNow ? "Running…" : "Run now (live)"}</button>
          {!connected ? <button type="button" onClick={() => goTo("settings")} className="text-xs underline text-[var(--color-mute)]">Connect in Settings →</button> : null}
        </div>
      </div>

      <div className="bg-white rounded-lg border border-black/5 p-5">
        <h2 className="font-serif text-xl mb-2">Latest post</h2>
        {lastPosted ? (
          <>
            <p className="text-sm font-medium">{lastPosted.topic || lastPosted.planTitle}</p>
            <p className="text-xs text-[var(--color-mute)] mt-1 line-clamp-3">{lastPosted.captionPreview}</p>
            <div className="mt-3 text-xs flex gap-3">
              <SafeLink url={lastPosted.linkedinPostUrl} label="View on LinkedIn ↗" />
              <button type="button" onClick={() => goTo("posts")} className="underline text-[var(--color-mute)]">All posts →</button>
            </div>
          </>
        ) : (
          <p className="text-sm text-[var(--color-mute)] italic">No posts yet. Run one from the Generate tab or here.</p>
        )}
      </div>

      <div className="bg-white rounded-lg border border-black/5 p-5 lg:col-span-2">
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="font-serif text-xl">Recent activity</h2>
          <button type="button" onClick={() => goTo("posts")} className="text-xs underline text-[var(--color-mute)]">View all</button>
        </div>
        {runs.length === 0 ? <p className="text-sm text-[var(--color-mute)] italic">Nothing yet.</p> : (
          <ul className="grid gap-1.5">
            {runs.slice(0, 5).map((r) => {
              const b = BADGE[r.status] ?? { label: r.status, cls: "bg-gray-100" };
              return (
                <li key={r.id} className="flex items-center justify-between gap-2 text-sm border-b border-black/5 pb-1.5 last:border-0">
                  <span className="flex items-center gap-2 min-w-0">
                    <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0 ${b.cls}`}>{b.label}</span>
                    <span className="truncate">{r.topic || r.planTitle || "—"}</span>
                  </span>
                  <span className="text-[10px] uppercase tracking-wider text-[var(--color-mute)] shrink-0">{formatDate(r.createdAt)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {alerts.length > 0 ? (
        <div className="bg-white rounded-lg border border-black/5 p-5 lg:col-span-2">
          <div className="flex items-baseline justify-between mb-2">
            <h2 className="font-serif text-xl">Recent alerts</h2>
            <button type="button" onClick={() => goTo("alerts")} className="text-xs underline text-[var(--color-mute)]">View all</button>
          </div>
          <ul className="grid gap-1.5">
            {alerts.slice(0, 4).map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-2 text-sm border-b border-black/5 pb-1.5 last:border-0">
                <span className="flex items-center gap-2 min-w-0">
                  <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0 ${ALERT_BADGE[a.status] ?? "bg-gray-100"}`}>{a.status}</span>
                  <span className="truncate">{a.subject}</span>
                </span>
                <span className="text-[10px] uppercase tracking-wider text-[var(--color-mute)] shrink-0">{formatDate(a.createdAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function PostsTab({ runs, onChanged }: { runs: AutomationRunWire[]; onChanged: () => void }) {
  if (runs.length === 0) {
    return <p className="text-sm text-[var(--color-mute)] italic">No runs yet. Use “Run now” on the Overview tab or build one in Generate.</p>;
  }
  return (
    <ul className="grid gap-2">
      {runs.map((r) => <RunRow key={r.id} run={r} onChanged={onChanged} />)}
    </ul>
  );
}

function RunRow({ run, onChanged }: { run: AutomationRunWire; onChanged: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const pdfRef = useRef<HTMLAnchorElement>(null);
  const liRef = useRef<HTMLAnchorElement>(null);
  const badge = BADGE[run.status] ?? { label: run.status, cls: "bg-gray-100 text-gray-700" };

  useEffect(() => {
    if (pdfRef.current && run.pdfUrl && run.pdfUrl.startsWith("https://")) pdfRef.current.href = run.pdfUrl;
    const li = run.linkedinPostUrl;
    if (liRef.current && li && li.startsWith("https://www.linkedin.com/")) liRef.current.href = li;
  }, [run.pdfUrl, run.linkedinPostUrl]);

  async function del() {
    if (!window.confirm("Delete this post from LinkedIn?")) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/automation/runs/${run.id}/delete-post`, { method: "POST" });
      if (!res.ok) { const j = (await res.json().catch(() => ({}))) as { error?: string }; window.alert(j.error || "Delete failed"); }
    } finally { setBusy(false); onChanged(); }
  }
  async function retry() {
    setBusy(true);
    try { await fetch(`/api/automation/runs/${run.id}/retry`, { method: "POST" }); } finally { setBusy(false); onChanged(); }
  }
  async function openApproval() {
    // Re-issues the single-use link (rotating the emailed one) and opens the
    // approval page in a new tab — same flow as clicking the email. The
    // server's URL is never opened verbatim: only its token is extracted and
    // re-encoded onto the FIXED same-origin /approve path, so a tampered
    // response can't redirect the browser anywhere else.
    setBusy(true);
    try {
      const res = await fetch(`/api/automation/runs/${run.id}/approval-link`, { method: "POST" });
      const j = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      const approvalToken = j.url ? new URL(j.url, window.location.origin).searchParams.get("token") : null;
      if (res.ok && approvalToken) window.open(`/approve?token=${encodeURIComponent(approvalToken)}`, "_blank", "noopener");
      else window.alert(j.error || "Could not create an approval link");
    } finally { setBusy(false); onChanged(); }
  }

  return (
    <li className="bg-white rounded-lg border border-black/5 p-3 grid gap-1.5">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0 ${badge.cls}`}>{badge.label}</span>
          {run.dryRun && run.status !== "dry_run" ? <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 shrink-0">dry</span> : null}
          <span className="text-sm font-medium truncate">{run.topic || run.planTitle || "(picking topic…)"}</span>
        </div>
        <span className="text-[10px] uppercase tracking-wider text-[var(--color-mute)] shrink-0">{run.trigger} · {formatDate(run.createdAt)}</span>
      </div>
      {run.captionPreview ? <p className="text-xs text-[var(--color-mute)] line-clamp-2">{run.captionPreview}</p> : null}
      {run.error ? <p className="text-xs text-red-700">{run.error}</p> : null}
      <div className="flex items-center gap-3 flex-wrap text-xs mt-0.5">
        {run.pdfUrl ? <a ref={pdfRef} target="_blank" rel="noreferrer" className="text-[var(--color-ink)] underline">PDF</a> : null}
        {run.linkedinPostUrl ? <a ref={liRef} target="_blank" rel="noreferrer" className="text-[var(--color-ink)] underline">View on LinkedIn ↗</a> : null}
        {run.caption ? <button type="button" onClick={() => setExpanded((v) => !v)} className="underline text-[var(--color-mute)]">{expanded ? "Hide caption" : "View caption"}</button> : null}
        {run.status === "awaiting_approval" ? <button type="button" onClick={openApproval} disabled={busy} className="underline text-purple-700 font-medium disabled:opacity-50">Review &amp; approve</button> : null}
        {(run.status === "failed" || run.status === "blocked") ? <button type="button" onClick={retry} disabled={busy} className="underline text-amber-700 disabled:opacity-50">Retry</button> : null}
        {run.status === "posted" && run.linkedinPostUrl ? <button type="button" onClick={del} disabled={busy} className="underline text-red-700 disabled:opacity-50">Delete from LinkedIn</button> : null}
      </div>
      {expanded && run.caption ? <pre className="text-xs whitespace-pre-wrap bg-[var(--color-cream)] rounded p-3 mt-1 font-sans">{run.caption}</pre> : null}
    </li>
  );
}

function AlertsTab({ alerts }: { alerts: AlertWire[] }) {
  if (alerts.length === 0) {
    return <p className="text-sm text-[var(--color-mute)] italic">No alerts yet. You’ll see an entry here for every post, block, failure, and token-expiry email.</p>;
  }
  return (
    <ul className="grid gap-2">
      {alerts.map((a) => (
        <li key={a.id} className="bg-white rounded-lg border border-black/5 p-3 grid gap-1">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="flex items-center gap-2 min-w-0">
              <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0 ${ALERT_BADGE[a.status] ?? "bg-gray-100"}`}>{a.status}</span>
              <span className="text-sm font-medium truncate">{a.subject}</span>
            </span>
            <span className="text-[10px] uppercase tracking-wider text-[var(--color-mute)] shrink-0">{formatDate(a.createdAt)}</span>
          </div>
          <p className="text-xs text-[var(--color-mute)]">{a.kind}{a.recipient ? ` → ${a.recipient}` : ""}{a.detail ? ` · ${a.detail}` : ""}</p>
        </li>
      ))}
    </ul>
  );
}

function SettingsTab({
  status, settings, connected, busyToggle, busyRunNow, onToggle, onRunNow, onDisconnect,
}: {
  status: LinkedinStatus | null; settings: AutomationSettingsResponse | null; connected: boolean;
  busyToggle: boolean; busyRunNow: boolean;
  onToggle: (f: "enabled" | "dryRun" | "approvalMode", v: boolean) => void; onRunNow: (dryRun: boolean) => void; onDisconnect: () => void;
}) {
  const daysLeft = connected && status?.connected ? status.daysLeft : null;
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div className="bg-white rounded-lg border border-black/5 p-5">
        <p className="text-xs uppercase tracking-wider text-[var(--color-mute)] mb-2">LinkedIn connection</p>
        {connected && status?.connected ? (
          <>
            <p className="text-sm">Connected as <span className="font-medium">{status.memberName}</span></p>
            {daysLeft != null ? <p className={`text-xs mt-1 ${daysLeft <= 0 ? "text-red-700" : daysLeft <= 7 ? "text-amber-700" : "text-[var(--color-mute)]"}`}>{daysLeft <= 0 ? "Token expired — reconnect to resume posting." : `Token valid ~${daysLeft} day${daysLeft === 1 ? "" : "s"}${daysLeft <= 7 ? " — reconnect soon" : ""}.`}</p> : null}
            <div className="flex items-center gap-3 mt-3">
              <a href="/api/linkedin/connect" className="text-sm bg-[var(--color-ink)] text-[var(--color-cream)] px-3 py-1.5 rounded">Reconnect</a>
              <button type="button" onClick={onDisconnect} className="text-sm underline text-[var(--color-mute)]">Disconnect</button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-[var(--color-mute)] mb-3">Authorize once so the app can post the PDF document to your profile.</p>
            <a href="/api/linkedin/connect" className="inline-block text-sm bg-[var(--color-amber)] text-[var(--color-ink)] px-4 py-2 rounded font-medium">Connect LinkedIn</a>
          </>
        )}
      </div>

      <div className="bg-white rounded-lg border border-black/5 p-5 grid gap-3">
        <p className="text-xs uppercase tracking-wider text-[var(--color-mute)]">Automation</p>
        <label className="flex items-center justify-between gap-3 text-sm">
          <span><span className="font-medium">Daily automation</span><span className="block text-xs text-[var(--color-mute)]">{settings?.scheduleLabel ?? ""}</span></span>
          <input type="checkbox" checked={!!settings?.enabled} disabled={busyToggle} onChange={(e) => onToggle("enabled", e.target.checked)} className="w-5 h-5 accent-[var(--color-amber)]" />
        </label>
        <label className="flex items-center justify-between gap-3 text-sm">
          <span><span className="font-medium">Dry-run mode</span><span className="block text-xs text-[var(--color-mute)]">Generate daily but don’t post. Off = publish for real.</span></span>
          <input type="checkbox" checked={!!settings?.dryRun} disabled={busyToggle} onChange={(e) => onToggle("dryRun", e.target.checked)} className="w-5 h-5 accent-[var(--color-amber)]" />
        </label>
        <label className="flex items-center justify-between gap-3 text-sm">
          <span><span className="font-medium">Approval mode</span><span className="block text-xs text-[var(--color-mute)]">Generate daily, but hold each post until you approve it from an email link — and add your own take before it goes out. Unapproved posts expire after 24h without posting.</span></span>
          <input type="checkbox" checked={!!settings?.approvalMode} disabled={busyToggle} onChange={(e) => onToggle("approvalMode", e.target.checked)} className="w-5 h-5 accent-[var(--color-amber)]" />
        </label>
        <div className="border-t border-black/5 pt-3 flex items-center gap-3 flex-wrap">
          <button type="button" onClick={() => onRunNow(true)} disabled={busyRunNow} className="text-sm bg-[var(--color-ink)] text-[var(--color-cream)] px-3 py-1.5 rounded disabled:opacity-50">{busyRunNow ? "Running…" : "Run now (dry-run)"}</button>
          <button type="button" onClick={() => onRunNow(false)} disabled={busyRunNow || !connected} className="text-sm bg-[var(--color-amber)] text-[var(--color-ink)] px-3 py-1.5 rounded font-medium disabled:opacity-50">{busyRunNow ? "Running…" : "Run now (live)"}</button>
        </div>
        <p className="text-[11px] text-[var(--color-mute)]">Email alerts go to your configured address. Posts auto-pick a fresh trending AI/ML topic.</p>
      </div>
    </div>
  );
}

function SafeLink({ url, label }: { url: string | null; label: string }) {
  const ref = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (ref.current && url && url.startsWith("https://www.linkedin.com/")) ref.current.href = url;
  }, [url]);
  if (!url) return null;
  return <a ref={ref} target="_blank" rel="noreferrer" className="text-[var(--color-ink)] underline">{label}</a>;
}
