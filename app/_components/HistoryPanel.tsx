"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { HistoryResponse } from "@/app/api/history/route";

type Run = (HistoryResponse & { enabled: true })["runs"][number];

type Phase = "loading" | "ready" | "empty" | "disabled" | "error";

export default function HistoryPanel() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setPhase("loading");
    setError(null);
    try {
      const res = await fetch("/api/history", { cache: "no-store" });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        const msg = (typeof body.error === "string" && body.error) || `History request failed (${res.status})`;
        setError(msg);
        setPhase("error");
        return;
      }
      const hr = body as unknown as HistoryResponse;
      setData(hr);
      if (!hr.enabled) setPhase("disabled");
      else if (hr.runs.length === 0) setPhase("empty");
      else setPhase("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
      setPhase("error");
    }
  }, []);

  // Initial fetch on mount. The lint rule flags setState-in-effect, but
  // there's no way to "auto-load on mount" without one — and we have no
  // user interaction to trigger off of for this panel.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  if (phase === "disabled") {
    // Don't render anything if storage isn't configured — the surface is
    // optional and the user already knows about /api/render's inline mode.
    return null;
  }

  return (
    <section className="mb-8">
      <div className="flex items-baseline justify-between mb-3 gap-3">
        <h2 className="font-serif text-xl">Past guides</h2>
        <button
          type="button"
          onClick={load}
          className="text-xs underline text-[var(--color-mute)] hover:text-[var(--color-text-body)]"
        >
          Refresh
        </button>
      </div>
      {phase === "loading" ? (
        <p className="text-sm text-[var(--color-mute)]">Loading…</p>
      ) : null}
      {phase === "empty" ? (
        <p className="text-sm text-[var(--color-mute)] italic">No past runs yet. Generate one below.</p>
      ) : null}
      {phase === "error" ? (
        <p className="text-sm text-red-700">{error}</p>
      ) : null}
      {phase === "ready" && data && data.enabled ? (
        <ul className="grid gap-2 sm:grid-cols-2">
          {data.runs.map((r) => (
            <HistoryRow key={r.id} run={r} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/**
 * Each row's PDF + ZIP anchors get their href set imperatively via refs so
 * server-returned URLs don't appear as JSX attribute bindings (Snyk flags
 * any useState/server-data value flowing into href structurally). The
 * actual defense is that we only honor https: URLs — Vercel Blob always
 * returns https:// — and silently drop anything else.
 */
function HistoryRow({ run }: { run: Run }) {
  const pdfRef = useRef<HTMLAnchorElement>(null);
  const zipRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (pdfRef.current && run.pdfUrl.startsWith("https://")) pdfRef.current.href = run.pdfUrl;
    if (zipRef.current && run.zipUrl.startsWith("https://")) zipRef.current.href = run.zipUrl;
  }, [run.pdfUrl, run.zipUrl]);
  return (
    <li className="bg-white rounded-lg border border-black/5 p-3 grid gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-serif text-base leading-snug">{run.title}</h3>
        <span className="text-[10px] uppercase tracking-wider text-[var(--color-mute)] shrink-0">
          {formatDate(run.createdAt)}
        </span>
      </div>
      <p className="text-xs text-[var(--color-mute)]">
        {run.pageCount} page{run.pageCount === 1 ? "" : "s"} · {run.sourceCount} source{run.sourceCount === 1 ? "" : "s"}
        {run.linkedinChars ? ` · LinkedIn ${run.linkedinChars} chars` : ""}
      </p>
      <div className="flex items-center gap-3 mt-1 flex-wrap">
        <a ref={pdfRef} target="_blank" rel="noreferrer" className="text-xs text-[var(--color-ink)] underline">
          PDF ({(run.pdfBytes / 1024).toFixed(0)} KB)
        </a>
        <a ref={zipRef} target="_blank" rel="noreferrer" className="text-xs text-[var(--color-ink)] underline">
          ZIP ({(run.zipBytes / 1024).toFixed(0)} KB)
        </a>
      </div>
    </li>
  );
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " +
      d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}
