"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PlanT } from "@/lib/plan-schema";

export type DrawnSvg = {
  id: string;
  title: string;
  layout: "landscape" | "portrait";
  svg: string;
  viewBox: string;
  tagCount: number;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  error?: string;
};

export type SvgMeta = {
  completed: number;
  failed: number;
  totalTokensIn: number;
  totalTokensOut: number;
  durationMs: number;
  model: string;
};

type Props = {
  plan: PlanT;
  autoStart?: boolean;
  onUpdate: (svgs: Record<string, DrawnSvg>, meta: SvgMeta | null, state: "idle" | "streaming" | "ready" | "error") => void;
};

export default function SvgPanel({ plan, autoStart, onUpdate }: Props) {
  const [phase, setPhase] = useState<"idle" | "streaming" | "ready" | "error">("idle");
  const [status, setStatus] = useState<{ message: string; elapsedMs: number } | null>(null);
  const [svgs, setSvgs] = useState<Record<string, DrawnSvg>>({});
  const [meta, setMeta] = useState<SvgMeta | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setPhase("streaming");
    setStatus({ message: "Starting…", elapsedMs: 0 });
    setSvgs({});
    setMeta(null);
    setError(null);

    let terminated = false;
    try {
      const res = await fetch("/api/svg", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        // If the body looks like an HTML error page (Vercel/Next.js 500), don't
        // dump it into the UI — that's where the giant raw-HTML blobs come
        // from. Show the status with a hint instead.
        const looksHtml = text.trim().startsWith("<") || (res.headers.get("content-type") || "").includes("text/html");
        setError(
          looksHtml
            ? `Server error (${res.status}). The /api/svg function crashed before any events were sent — check Vercel logs.`
            : (text || `SVG request failed (${res.status})`),
        );
        setPhase("error");
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!terminated) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const lines = chunk.split("\n");
          const event = lines.find((l) => l.startsWith("event:"))?.slice(6).trim() || "message";
          const dataLine = lines.find((l) => l.startsWith("data:"))?.slice(5).trim() || "";
          if (!dataLine) continue;
          let parsed: unknown;
          try { parsed = JSON.parse(dataLine); } catch { continue; }
          if (event === "status") {
            const s = parsed as { message?: string; elapsedMs?: number };
            setStatus({ message: s.message || "Working…", elapsedMs: s.elapsedMs ?? 0 });
          } else if (event === "svg") {
            const drawn = parsed as DrawnSvg;
            setSvgs((prev) => ({ ...prev, [drawn.id]: drawn }));
          } else if (event === "done") {
            const m = parsed as SvgMeta;
            setMeta(m);
            setPhase("ready");
          } else if (event === "error") {
            const e = parsed as { message?: string };
            setError(e.message || "SVG generation failed");
            setPhase("error");
            terminated = true;
            return;
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
      setPhase("error");
    }
  }, [plan]);

  // Auto-start once when prop is set
  const startedRef = useRef(false);
  useEffect(() => {
    if (autoStart && !startedRef.current) {
      startedRef.current = true;
      void run();
    }
  }, [autoStart, run]);

  // Bubble state up so the page can decide when to enable Render PDF
  useEffect(() => {
    onUpdate(svgs, meta, phase);
  }, [svgs, meta, phase, onUpdate]);

  return (
    <section className="mb-8">
      <div className="flex items-baseline justify-between mb-3 gap-3 flex-wrap">
        <h2 className="font-serif text-2xl">Diagrams</h2>
        {phase === "streaming" && status ? (
          <p className="text-xs text-[var(--color-mute)] tabular-nums">{status.message} ({(status.elapsedMs / 1000).toFixed(1)}s)</p>
        ) : null}
        {phase === "ready" && meta ? (
          <p className="text-xs text-[var(--color-mute)] tabular-nums">
            {meta.model} · {meta.completed} drawn{meta.failed ? `, ${meta.failed} failed` : ""} · {meta.totalTokensIn} in / {meta.totalTokensOut} out tokens · {(meta.durationMs / 1000).toFixed(1)}s
          </p>
        ) : null}
      </div>

      {phase === "idle" ? (
        <button type="button" onClick={run} className="bg-[var(--color-ink)] text-[var(--color-cream)] px-5 py-2.5 rounded font-medium">
          Draw {plan.infographics.length} infographic{plan.infographics.length === 1 ? "" : "s"}
        </button>
      ) : null}

      {phase !== "idle" ? (
        <ul className="grid gap-3 sm:grid-cols-2 mb-3">
          {plan.infographics.map((info) => {
            const drawn = svgs[info.id];
            const state = drawn ? (drawn.error ? "error" : "ready") : (phase === "streaming" ? "drawing" : "queued");
            return (
              <li
                key={info.id}
                className={`bg-white rounded-lg border ${drawn?.error ? "border-red-200" : "border-black/5"} p-3 grid gap-2`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="font-serif text-base leading-snug">{info.title}</h3>
                  <SvgStatePill state={state} />
                </div>
                <p className="text-xs text-[var(--color-mute)] italic line-clamp-2">{info.concept}</p>
                {drawn && !drawn.error ? (
                  <div className="bg-[var(--color-paper)] rounded p-2 border border-black/5">
                    <div
                      className="w-full"
                      dangerouslySetInnerHTML={{ __html: drawn.svg }}
                    />
                  </div>
                ) : null}
                {drawn?.error ? (
                  <p className="text-xs text-red-700">{drawn.error}</p>
                ) : null}
                {drawn && !drawn.error ? (
                  <p className="text-[10px] text-[var(--color-mute)] tabular-nums">
                    {drawn.tagCount} elements · viewBox {drawn.viewBox} · {drawn.tokensIn} in / {drawn.tokensOut} out · {(drawn.durationMs / 1000).toFixed(1)}s
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {phase === "ready" ? (
        <button type="button" onClick={run} className="text-sm underline text-[var(--color-mute)] hover:text-[var(--color-text-body)]">
          Redraw all
        </button>
      ) : null}
      {phase === "error" ? (
        <>
          <button type="button" onClick={run} className="bg-[var(--color-ink)] text-[var(--color-cream)] px-4 py-2 rounded text-sm">Try again</button>
          {error ? <p className="text-sm text-red-700 mt-2">{error}</p> : null}
        </>
      ) : null}
    </section>
  );
}

function SvgStatePill({ state }: { state: "queued" | "drawing" | "ready" | "error" }) {
  const styles = {
    queued: "bg-black/5 text-[var(--color-mute)]",
    drawing: "bg-[var(--color-amber)]/20 text-amber-900",
    ready: "bg-emerald-100 text-emerald-800",
    error: "bg-red-100 text-red-800",
  } as const;
  const label = {
    queued: "queued",
    drawing: "drawing…",
    ready: "ready",
    error: "failed",
  } as const;
  return <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${styles[state]}`}>{label[state]}</span>;
}
