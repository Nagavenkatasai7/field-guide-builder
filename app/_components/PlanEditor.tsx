"use client";

import { useCallback, useMemo, useState } from "react";
import { Plan, SECTION_KINDS, type PlanT, type SectionT, type InfographicT } from "@/lib/plan-schema";
import type { ResearchResponse } from "@/app/api/research/route";

type Props = {
  research: ResearchResponse;
  summary: string;
  onApprove: (plan: PlanT) => void;
};

type StreamStatus = {
  message: string;
  elapsedMs: number;
};

type Phase = "idle" | "streaming" | "editing" | "error";

function newId(prefix: string): string {
  const suffix = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${suffix}`;
}

function emptySection(): SectionT {
  return { id: newId("sec"), kind: "body", title: "New section", background: "cream", brief: "", infographicId: null };
}

function emptyInfographic(): InfographicT {
  return { id: newId("info"), title: "New infographic", concept: "", layout: "landscape" };
}

export default function PlanEditor({ research, summary, onApprove }: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState<StreamStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanT | null>(null);
  const [meta, setMeta] = useState<{ model: string; tokensIn: number; tokensOut: number; durationMs: number } | null>(null);

  const dangling = useMemo(() => {
    if (!plan) return new Set<string>();
    const validIds = new Set(plan.infographics.map((i) => i.id));
    const bad = new Set<string>();
    for (const s of plan.sections) if (s.infographicId && !validIds.has(s.infographicId)) bad.add(s.id);
    return bad;
  }, [plan]);

  const run = useCallback(async () => {
    setPhase("streaming");
    setStatus({ message: "Starting…", elapsedMs: 0 });
    setError(null);
    setPlan(null);
    setMeta(null);
    let gotPlan = false;
    let terminated = false;
    try {
      const res = await fetch("/api/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic: research.topic, summary, sources: research.sources }),
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        const looksHtml = text.trim().startsWith("<") || (res.headers.get("content-type") || "").includes("text/html");
        setError(
          looksHtml
            ? `Server error (${res.status}). The /api/plan function crashed before any events were sent — check Vercel logs.`
            : (text || `Plan request failed (${res.status})`),
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
          } else if (event === "plan") {
            const p = parsed as { plan: unknown; meta?: typeof meta };
            const planParsed = Plan.safeParse(p.plan);
            if (!planParsed.success) {
              setError("Server returned an invalid plan shape.");
              setPhase("error");
              terminated = true;
              return;
            }
            setPlan(planParsed.data);
            if (p.meta) setMeta(p.meta);
            gotPlan = true;
          } else if (event === "done") {
            setPhase("editing");
          } else if (event === "error") {
            const e = parsed as { message?: string };
            setError(e.message || "Plan generation failed");
            setPhase("error");
            terminated = true;
            return;
          }
        }
      }
      if (!gotPlan && !terminated) {
        setError("Stream ended before a plan arrived.");
        setPhase("error");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
      setPhase("error");
    }
  }, [research, summary]);

  if (phase === "idle") {
    return (
      <section className="mb-8">
        <button
          type="button"
          onClick={run}
          className="bg-[var(--color-ink)] text-[var(--color-cream)] px-5 py-2.5 rounded font-medium"
        >
          Generate plan from {research.sources.length} source{research.sources.length === 1 ? "" : "s"}
        </button>
        <p className="text-xs text-[var(--color-mute)] mt-2">Gemma 4 31B with thinking mode. ~30–90 seconds.</p>
      </section>
    );
  }

  if (phase === "streaming") {
    return (
      <section className="mb-8 bg-white rounded-lg border border-black/5 p-6">
        <div className="flex items-center gap-3 mb-2">
          <Spinner />
          <h2 className="font-serif text-2xl">Planning…</h2>
        </div>
        <p className="text-sm text-[var(--color-mute)]">
          {status?.message || "Working…"} <span className="tabular-nums">({((status?.elapsedMs ?? 0) / 1000).toFixed(1)}s)</span>
        </p>
      </section>
    );
  }

  if (phase === "error") {
    return (
      <section className="mb-8 bg-white rounded-lg border border-red-200 p-6">
        <h2 className="font-serif text-2xl mb-2">Plan failed</h2>
        <p className="text-sm text-red-700 mb-3">{error}</p>
        <button type="button" onClick={run} className="bg-[var(--color-ink)] text-[var(--color-cream)] px-4 py-2 rounded text-sm">
          Try again
        </button>
      </section>
    );
  }

  if (!plan) return null;

  return (
    <section className="mb-8">
      <div className="flex items-baseline justify-between mb-3 gap-3 flex-wrap">
        <h2 className="font-serif text-2xl">Plan</h2>
        {meta ? (
          <p className="text-xs text-[var(--color-mute)]">
            {meta.model} · {meta.tokensIn} in / {meta.tokensOut} out tokens · {(meta.durationMs / 1000).toFixed(1)}s
          </p>
        ) : null}
      </div>

      <div className="bg-white rounded-lg border border-black/5 p-6 grid gap-4 mb-4">
        <Field label="Title" value={plan.title} onChange={(v) => setPlan({ ...plan, title: v })} />
        <Field label="Subtitle" value={plan.subtitle ?? ""} onChange={(v) => setPlan({ ...plan, subtitle: v })} />
        <Field label="Audience" value={plan.audience} onChange={(v) => setPlan({ ...plan, audience: v })} multiline />
      </div>

      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="font-serif text-xl">Sections <span className="text-sm text-[var(--color-mute)] font-sans">({plan.sections.length})</span></h3>
        <button
          type="button"
          onClick={() => setPlan({ ...plan, sections: [...plan.sections, emptySection()] })}
          className="text-xs underline text-[var(--color-mute)] hover:text-[var(--color-text-body)]"
          disabled={plan.sections.length >= 15}
        >
          + add section
        </button>
      </div>
      <ol className="grid gap-2 mb-6">
        {plan.sections.map((section, idx) => (
          <SectionRow
            key={section.id}
            idx={idx}
            section={section}
            infographics={plan.infographics}
            dangling={dangling.has(section.id)}
            canRemove={plan.sections.length > 8}
            isLast={idx === plan.sections.length - 1}
            onMove={(from, to) => {
              if (from === to || to < 0 || to >= plan.sections.length) return;
              const next = [...plan.sections];
              const [moved] = next.splice(from, 1);
              next.splice(to, 0, moved);
              setPlan({ ...plan, sections: next });
            }}
            onChange={(updated) => {
              const next = [...plan.sections];
              next[idx] = updated;
              setPlan({ ...plan, sections: next });
            }}
            onRemove={() => {
              const next = plan.sections.filter((_, i) => i !== idx);
              setPlan({ ...plan, sections: next });
            }}
          />
        ))}
      </ol>

      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="font-serif text-xl">Infographics <span className="text-sm text-[var(--color-mute)] font-sans">({plan.infographics.length})</span></h3>
        <button
          type="button"
          onClick={() => setPlan({ ...plan, infographics: [...plan.infographics, emptyInfographic()] })}
          className="text-xs underline text-[var(--color-mute)] hover:text-[var(--color-text-body)]"
          disabled={plan.infographics.length >= 4}
        >
          + add infographic
        </button>
      </div>
      <ul className="grid gap-2 mb-6 sm:grid-cols-2">
        {plan.infographics.map((info, idx) => (
          <InfographicRow
            key={info.id}
            info={info}
            canRemove={plan.infographics.length > 2}
            onChange={(updated) => {
              const next = [...plan.infographics];
              next[idx] = updated;
              setPlan({ ...plan, infographics: next });
            }}
            onRemove={() => {
              const next = plan.infographics.filter((_, i) => i !== idx);
              setPlan({ ...plan, infographics: next });
            }}
          />
        ))}
      </ul>

      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={() => {
            const validated = Plan.safeParse(plan);
            if (!validated.success) {
              setError("Plan is invalid. Check section count (8–15) and infographic count (2–4).");
              return;
            }
            setError(null);
            onApprove(validated.data);
          }}
          className="bg-[var(--color-amber)] text-[var(--color-ink)] px-5 py-2.5 rounded font-medium"
        >
          Approve & continue
        </button>
        <button
          type="button"
          onClick={run}
          className="text-sm underline text-[var(--color-mute)] hover:text-[var(--color-text-body)]"
        >
          Regenerate plan
        </button>
        {dangling.size > 0 ? (
          <span className="text-xs text-amber-700">
            {dangling.size} section{dangling.size === 1 ? "" : "s"} reference a missing infographic
          </span>
        ) : null}
        {error ? <span className="text-sm text-red-700">{error}</span> : null}
      </div>
    </section>
  );
}

function Spinner() {
  return (
    <span className="inline-block w-4 h-4 border-2 border-[var(--color-amber)] border-t-transparent rounded-full animate-spin" aria-hidden />
  );
}

function Field({
  label, value, onChange, multiline,
}: { label: string; value: string; onChange: (v: string) => void; multiline?: boolean }) {
  return (
    <div>
      <label className="block text-xs uppercase tracking-wider text-[var(--color-mute)] mb-1">{label}</label>
      {multiline ? (
        <textarea
          rows={2}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full border border-black/15 rounded px-3 py-2 focus:outline-none focus:border-[var(--color-amber)]"
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full border border-black/15 rounded px-3 py-2 focus:outline-none focus:border-[var(--color-amber)]"
        />
      )}
    </div>
  );
}

function SectionRow({
  idx, section, infographics, dangling, canRemove, isLast, onMove, onChange, onRemove,
}: {
  idx: number;
  section: SectionT;
  infographics: InfographicT[];
  dangling: boolean;
  canRemove: boolean;
  isLast: boolean;
  onMove: (from: number, to: number) => void;
  onChange: (s: SectionT) => void;
  onRemove: () => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  return (
    <li
      draggable
      onDragStart={(e) => e.dataTransfer.setData("text/plain", String(idx))}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const from = Number(e.dataTransfer.getData("text/plain"));
        if (!Number.isNaN(from)) onMove(from, idx);
      }}
      className={`bg-white rounded-lg border ${dragOver ? "border-[var(--color-amber)]" : "border-black/5"} p-3 grid gap-2`}
    >
      <div className="flex items-center gap-2 text-xs text-[var(--color-mute)]">
        <span className="cursor-grab select-none px-1" title="Drag to reorder">⋮⋮</span>
        <span className="tabular-nums w-6 text-right">{idx + 1}.</span>
        <select
          value={section.kind}
          onChange={(e) => onChange({ ...section, kind: e.target.value as typeof SECTION_KINDS[number] })}
          className="border border-black/15 rounded px-1 py-0.5 text-xs"
        >
          {SECTION_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <select
          value={section.background}
          onChange={(e) => onChange({ ...section, background: e.target.value as "dark" | "cream" })}
          className="border border-black/15 rounded px-1 py-0.5 text-xs"
        >
          <option value="cream">cream</option>
          <option value="dark">dark</option>
        </select>
        <select
          value={section.infographicId ?? ""}
          onChange={(e) => onChange({ ...section, infographicId: e.target.value || null })}
          className="border border-black/15 rounded px-1 py-0.5 text-xs"
        >
          <option value="">no infographic</option>
          {infographics.map((i) => <option key={i.id} value={i.id}>{i.title}</option>)}
        </select>
        {dangling ? <span className="text-amber-700">⚠ dangling link</span> : null}
        <div className="grow" />
        <button
          type="button"
          onClick={() => onMove(idx, idx - 1)}
          disabled={idx === 0}
          className="disabled:opacity-30"
          aria-label="Move up"
        >↑</button>
        <button
          type="button"
          onClick={() => onMove(idx, idx + 1)}
          disabled={isLast}
          className="disabled:opacity-30"
          aria-label="Move down"
        >↓</button>
        {canRemove ? (
          <button type="button" onClick={onRemove} className="text-red-600" aria-label="Remove section">×</button>
        ) : null}
      </div>
      <input
        type="text"
        value={section.title}
        onChange={(e) => onChange({ ...section, title: e.target.value })}
        className="w-full font-serif text-lg border-b border-transparent focus:border-[var(--color-amber)] focus:outline-none px-1"
      />
      <textarea
        rows={2}
        placeholder="Editorial brief — what to write here"
        value={section.brief}
        onChange={(e) => onChange({ ...section, brief: e.target.value })}
        className="w-full text-sm border border-black/10 rounded px-2 py-1.5 focus:outline-none focus:border-[var(--color-amber)]"
      />
    </li>
  );
}

function InfographicRow({
  info, canRemove, onChange, onRemove,
}: { info: InfographicT; canRemove: boolean; onChange: (i: InfographicT) => void; onRemove: () => void }) {
  return (
    <li className="bg-white rounded-lg border border-black/5 p-3 grid gap-2">
      <div className="flex items-center gap-2 text-xs text-[var(--color-mute)]">
        <span className="font-mono text-[10px] bg-[var(--color-cream)] border border-black/10 rounded px-1.5 py-0.5">{info.id}</span>
        <select
          value={info.layout}
          onChange={(e) => onChange({ ...info, layout: e.target.value as "landscape" | "portrait" })}
          className="border border-black/15 rounded px-1 py-0.5 text-xs"
        >
          <option value="landscape">landscape</option>
          <option value="portrait">portrait</option>
        </select>
        <div className="grow" />
        {canRemove ? (
          <button type="button" onClick={onRemove} className="text-red-600" aria-label="Remove infographic">×</button>
        ) : null}
      </div>
      <input
        type="text"
        value={info.title}
        onChange={(e) => onChange({ ...info, title: e.target.value })}
        className="w-full font-serif text-base border-b border-transparent focus:border-[var(--color-amber)] focus:outline-none px-1"
      />
      <textarea
        rows={3}
        placeholder="One sentence describing exactly what this diagram explains and how"
        value={info.concept}
        onChange={(e) => onChange({ ...info, concept: e.target.value })}
        className="w-full text-sm border border-black/10 rounded px-2 py-1.5 focus:outline-none focus:border-[var(--color-amber)]"
      />
    </li>
  );
}
