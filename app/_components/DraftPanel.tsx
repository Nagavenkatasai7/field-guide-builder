"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PlanT, SectionT } from "@/lib/plan-schema";
import type { ResearchResponse } from "@/app/api/research/route";

export type DraftedSection = {
  id: string;
  kind: SectionT["kind"];
  title: string;
  html: string;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  error?: string;
};

export type DraftMeta = {
  completed: number;
  failed: number;
  totalTokensIn: number;
  totalTokensOut: number;
  durationMs: number;
  model: string;
};

type Props = {
  plan: PlanT;
  research: ResearchResponse;
  autoStart?: boolean;
  onUpdate?: (drafts: Record<string, DraftedSection>, meta: DraftMeta | null, phase: Phase) => void;
};

type Phase = "idle" | "streaming" | "ready" | "error";

export default function DraftPanel({ plan, research, autoStart, onUpdate }: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState<{ message: string; elapsedMs: number } | null>(null);
  const [drafts, setDrafts] = useState<Record<string, DraftedSection>>({});
  const [meta, setMeta] = useState<DraftMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const draftableIds = useMemo(
    () => plan.sections.filter((s) => DRAFTABLE.has(s.kind)).map((s) => s.id),
    [plan.sections],
  );

  const run = useCallback(async () => {
    setPhase("streaming");
    setStatus({ message: "Starting…", elapsedMs: 0 });
    setDrafts({});
    setMeta(null);
    setError(null);

    let terminated = false;
    try {
      const res = await fetch("/api/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan, sources: research.sources }),
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        const looksHtml = text.trim().startsWith("<") || (res.headers.get("content-type") || "").includes("text/html");
        setError(
          looksHtml
            ? `Server error (${res.status}). The /api/draft function crashed before any events were sent — check Vercel logs.`
            : (text || `Draft request failed (${res.status})`),
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
          } else if (event === "section") {
            const sec = parsed as DraftedSection;
            setDrafts((prev) => ({ ...prev, [sec.id]: sec }));
          } else if (event === "done") {
            const m = parsed as DraftMeta;
            setMeta(m);
            setPhase("ready");
          } else if (event === "error") {
            const e = parsed as { message?: string };
            setError(e.message || "Drafting failed");
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
  }, [plan, research]);

  const startedRef = useRef(false);
  useEffect(() => {
    if (autoStart && !startedRef.current) {
      startedRef.current = true;
      void run();
    }
  }, [autoStart, run]);

  useEffect(() => {
    onUpdate?.(drafts, meta, phase);
  }, [drafts, meta, phase, onUpdate]);

  if (phase === "idle") {
    return (
      <section className="mb-8">
        <button
          type="button"
          onClick={run}
          className="bg-[var(--color-ink)] text-[var(--color-cream)] px-5 py-2.5 rounded font-medium"
        >
          Draft {draftableIds.length} section{draftableIds.length === 1 ? "" : "s"}
        </button>
        <p className="text-xs text-[var(--color-mute)] mt-2">
          Gemma 4 writes each section in parallel (3 at a time). Cover, TOC, and colophon are template-only and skipped here.
        </p>
      </section>
    );
  }

  return (
    <section className="mb-8">
      <div className="flex items-baseline justify-between mb-3 gap-3 flex-wrap">
        <h2 className="font-serif text-2xl">Draft</h2>
        {phase === "streaming" && status ? (
          <p className="text-xs text-[var(--color-mute)] tabular-nums">
            {status.message} ({(status.elapsedMs / 1000).toFixed(1)}s)
          </p>
        ) : null}
        {phase === "ready" && meta ? (
          <p className="text-xs text-[var(--color-mute)] tabular-nums">
            {meta.model} · {meta.completed} done{meta.failed ? `, ${meta.failed} failed` : ""} · {meta.totalTokensIn} in / {meta.totalTokensOut} out tokens · {(meta.durationMs / 1000).toFixed(1)}s
          </p>
        ) : null}
      </div>

      <ol className="grid gap-2 mb-4">
        {plan.sections.map((section, idx) => {
          const draft = drafts[section.id];
          const isDraftable = DRAFTABLE.has(section.kind);
          const state = !isDraftable
            ? "skipped"
            : draft
              ? draft.error
                ? "error"
                : "done"
              : phase === "streaming"
                ? "pending"
                : "idle";
          const isOpen = expanded.has(section.id);
          return (
            <li
              key={section.id}
              className={`bg-white rounded-lg border ${state === "error" ? "border-red-200" : "border-black/5"} p-3`}
            >
              <button
                type="button"
                onClick={() => {
                  if (!isDraftable || !draft || draft.error) return;
                  setExpanded((s) => {
                    const next = new Set(s);
                    if (next.has(section.id)) next.delete(section.id);
                    else next.add(section.id);
                    return next;
                  });
                }}
                disabled={!isDraftable || !draft || !!draft.error}
                className="w-full flex items-center gap-2 text-left disabled:cursor-default"
              >
                <span className="text-xs tabular-nums text-[var(--color-mute)] w-6 text-right">{idx + 1}.</span>
                <span className="font-serif text-base grow">{section.title}</span>
                <span className="text-[10px] uppercase tracking-wider text-[var(--color-mute)]">{section.kind}</span>
                <StatePill state={state} />
                {isDraftable && draft && !draft.error ? (
                  <span className="text-xs text-[var(--color-mute)]">{isOpen ? "▲" : "▼"}</span>
                ) : null}
              </button>
              {isOpen && draft && !draft.error ? (
                <div className="mt-3 border-t border-black/5 pt-3 grid gap-2">
                  <div
                    className="prose prose-sm max-w-none [&_p]:my-2 [&_blockquote]:border-l-4 [&_blockquote]:border-[var(--color-amber)] [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:my-2 [&_.amber]:text-[#7a5400] [&_.amber]:font-medium [&_.kicker]:text-xs [&_.kicker]:uppercase [&_.kicker]:tracking-wider [&_.kicker]:text-[var(--color-mute)] [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1"
                    dangerouslySetInnerHTML={{ __html: draft.html }}
                  />
                  <p className="text-[10px] text-[var(--color-mute)] tabular-nums">
                    {draft.tokensIn} in / {draft.tokensOut} out tokens · {(draft.durationMs / 1000).toFixed(1)}s
                  </p>
                </div>
              ) : null}
              {draft?.error ? (
                <p className="text-xs text-red-700 mt-2">{draft.error}</p>
              ) : null}
            </li>
          );
        })}
      </ol>

      <div className="flex items-center gap-3 flex-wrap">
        {phase === "ready" ? (
          <>
            <button
              type="button"
              onClick={run}
              className="text-sm underline text-[var(--color-mute)] hover:text-[var(--color-text-body)]"
            >
              Regenerate drafts
            </button>
            {meta && meta.failed > 0 ? (
              <span className="text-xs text-red-700">
                {meta.failed} section{meta.failed === 1 ? "" : "s"} failed — regenerate or come back later.
              </span>
            ) : null}
          </>
        ) : null}
        {phase === "error" ? (
          <>
            <button type="button" onClick={run} className="bg-[var(--color-ink)] text-[var(--color-cream)] px-4 py-2 rounded text-sm">
              Try again
            </button>
            {error ? <span className="text-sm text-red-700">{error}</span> : null}
          </>
        ) : null}
      </div>
    </section>
  );
}

const DRAFTABLE = new Set<SectionT["kind"]>([
  "definition", "problem", "body", "comparison", "step-by-step", "use-cases", "why-it-matters", "recap",
]);

function StatePill({ state }: { state: "idle" | "pending" | "done" | "error" | "skipped" }) {
  const styles: Record<typeof state, string> = {
    idle: "bg-black/5 text-[var(--color-mute)]",
    pending: "bg-[var(--color-amber)]/20 text-amber-900",
    done: "bg-emerald-100 text-emerald-800",
    error: "bg-red-100 text-red-800",
    skipped: "bg-black/5 text-[var(--color-mute)] italic",
  };
  const label: Record<typeof state, string> = {
    idle: "queued",
    pending: "writing…",
    done: "ready",
    error: "failed",
    skipped: "template",
  };
  return (
    <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${styles[state]}`}>
      {label[state]}
    </span>
  );
}
