"use client";

import { useCallback, useMemo, useState, type FormEvent } from "react";
import PlanEditor from "@/app/_components/PlanEditor";
import DraftPanel, { type DraftedSection, type DraftMeta } from "@/app/_components/DraftPanel";
import SvgPanel, { type DrawnSvg, type SvgMeta } from "@/app/_components/SvgPanel";
import LinkedinPanel from "@/app/_components/LinkedinPanel";
import RenderPanel from "@/app/_components/RenderPanel";
import type { PlanT } from "@/lib/plan-schema";
import type { ResearchResponse, ResearchSourceWire } from "@/app/api/research/route";

type BuildPhase = "idle" | "streaming" | "ready" | "error";

type FormState = {
  topic: string;
  urlsRaw: string;
  summary: string;
};

const EMPTY: FormState = { topic: "", urlsRaw: "", summary: "" };

function parseUrls(raw: string): { urls: string[]; invalid: string[] } {
  const candidates = raw
    .split(/[\n,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const urls: string[] = [];
  const invalid: string[] = [];
  for (const c of candidates) {
    try {
      const u = new URL(c);
      if (u.protocol === "http:" || u.protocol === "https:") urls.push(u.toString());
      else invalid.push(c);
    } catch {
      invalid.push(c);
    }
  }
  return { urls, invalid };
}

/**
 * The manual generation workspace (the original single-page flow): research →
 * editable plan → drafts ‖ svgs ‖ caption → render. Lives under the "Generate"
 * tab of the dashboard. Self-contained; manages its own generation state.
 */
export default function GenerateWorkspace() {
  const [form, setForm] = useState<FormState>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [research, setResearch] = useState<ResearchResponse | null>(null);
  const [approvedPlan, setApprovedPlan] = useState<PlanT | null>(null);
  const [drafts, setDrafts] = useState<Record<string, DraftedSection>>({});
  const [draftMeta, setDraftMeta] = useState<DraftMeta | null>(null);
  const [draftPhase, setDraftPhase] = useState<BuildPhase>("idle");
  const [svgs, setSvgs] = useState<Record<string, DrawnSvg>>({});
  const [svgMeta, setSvgMeta] = useState<SvgMeta | null>(null);
  const [svgPhase, setSvgPhase] = useState<BuildPhase>("idle");
  const [linkedinPost, setLinkedinPost] = useState<string>("");

  const handleDraftUpdate = useCallback(
    (d: Record<string, DraftedSection>, m: DraftMeta | null, p: BuildPhase) => {
      setDrafts(d);
      setDraftMeta(m);
      setDraftPhase(p);
    },
    [],
  );
  const handleSvgUpdate = useCallback(
    (s: Record<string, DrawnSvg>, m: SvgMeta | null, p: BuildPhase) => {
      setSvgs(s);
      setSvgMeta(m);
      setSvgPhase(p);
    },
    [],
  );

  const buildSettled = (draftPhase === "ready" || draftPhase === "error") &&
    (svgPhase === "ready" || svgPhase === "error");
  const buildHasError = draftPhase === "error" || svgPhase === "error" ||
    (draftMeta && draftMeta.failed > 0) || (svgMeta && svgMeta.failed > 0);
  const buildStillRunning = !buildSettled && approvedPlan != null;

  function startOver() {
    setError(null);
    setResearch(null);
    setApprovedPlan(null);
    setDrafts({}); setDraftMeta(null); setDraftPhase("idle");
    setSvgs({}); setSvgMeta(null); setSvgPhase("idle");
    setLinkedinPost("");
    setForm(EMPTY);
  }

  const { urls, invalid } = useMemo(() => parseUrls(form.urlsRaw), [form.urlsRaw]);
  const canSubmit = form.topic.trim().length >= 2 && !busy;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setResearch(null);
    setApprovedPlan(null);
    setDrafts({}); setDraftMeta(null); setDraftPhase("idle");
    setSvgs({}); setSvgMeta(null); setSvgPhase("idle");
    setLinkedinPost("");
    setBusy(true);
    try {
      const res = await fetch("/api/research", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic: form.topic.trim(), urls, summary: form.summary.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as ResearchResponse | { error?: string };
      if (!res.ok) {
        setError(("error" in data && data.error) || `Request failed (${res.status})`);
        return;
      }
      setResearch(data as ResearchResponse);
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex items-baseline justify-between mb-4 gap-3 flex-wrap">
        <div>
          <h2 className="font-serif text-2xl">Generate a guide</h2>
          <p className="text-sm text-[var(--color-mute)]">Manually build a Field Guide from a concept + sources.</p>
        </div>
        {approvedPlan ? (
          <button type="button" onClick={startOver} className="text-xs text-[var(--color-mute)] hover:text-[var(--color-text-body)] underline">
            Start over
          </button>
        ) : null}
      </div>

      <section className="bg-white rounded-lg border border-black/5 shadow-sm p-6 mb-8">
        <form onSubmit={onSubmit} className="grid gap-4">
          <div>
            <label htmlFor="topic" className="block text-xs uppercase tracking-wider text-[var(--color-mute)] mb-1">
              Concept / topic <span className="text-red-600">*</span>
            </label>
            <input
              id="topic"
              type="text"
              required
              minLength={2}
              maxLength={200}
              placeholder="e.g. Bumblebee by Perplexity"
              value={form.topic}
              onChange={(e) => setForm({ ...form, topic: e.target.value })}
              className="w-full border border-black/15 rounded px-3 py-2 focus:outline-none focus:border-[var(--color-amber)]"
            />
          </div>

          <div>
            <label htmlFor="urls" className="block text-xs uppercase tracking-wider text-[var(--color-mute)] mb-1">
              Reference URLs <span className="text-[var(--color-mute)] normal-case">(optional, one per line or comma-separated)</span>
            </label>
            <textarea
              id="urls"
              rows={3}
              placeholder="https://github.com/...&#10;https://blog.example.com/..."
              value={form.urlsRaw}
              onChange={(e) => setForm({ ...form, urlsRaw: e.target.value })}
              className="w-full border border-black/15 rounded px-3 py-2 font-mono text-sm focus:outline-none focus:border-[var(--color-amber)]"
            />
            <div className="flex justify-between text-xs mt-1 text-[var(--color-mute)]">
              <span>{urls.length} valid URL{urls.length === 1 ? "" : "s"}</span>
              {invalid.length > 0 ? <span className="text-amber-700">Ignoring {invalid.length} invalid entr{invalid.length === 1 ? "y" : "ies"}</span> : null}
            </div>
          </div>

          <div>
            <label htmlFor="summary" className="block text-xs uppercase tracking-wider text-[var(--color-mute)] mb-1">
              Short summary <span className="text-[var(--color-mute)] normal-case">(optional, 1–3 sentences on the angle)</span>
            </label>
            <textarea
              id="summary"
              rows={3}
              maxLength={1000}
              placeholder="What angle do you want the guide to take?"
              value={form.summary}
              onChange={(e) => setForm({ ...form, summary: e.target.value })}
              className="w-full border border-black/15 rounded px-3 py-2 focus:outline-none focus:border-[var(--color-amber)]"
            />
            <div className="text-xs mt-1 text-[var(--color-mute)] text-right">{form.summary.length}/1000</div>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={!canSubmit}
              className="bg-[var(--color-ink)] text-[var(--color-cream)] px-5 py-2.5 rounded font-medium disabled:opacity-50"
            >
              {busy ? "Researching…" : "Generate"}
            </button>
            {error ? <span className="text-sm text-red-600">{error}</span> : null}
          </div>
        </form>
      </section>

      {research ? <ResearchPanel research={research} /> : null}
      {research && !approvedPlan ? (
        <PlanEditor research={research} summary={form.summary.trim()} onApprove={setApprovedPlan} />
      ) : null}
      {approvedPlan ? (
        <>
          <DraftPanel
            plan={approvedPlan}
            research={research!}
            autoStart
            onUpdate={handleDraftUpdate}
          />
          <SvgPanel plan={approvedPlan} autoStart onUpdate={handleSvgUpdate} />
          {buildStillRunning ? (
            <section className="mb-8 bg-white rounded-lg border border-black/5 p-4">
              <p className="text-sm text-[var(--color-mute)]">
                <span className="font-medium">PDF unlocks when drafts and diagrams both settle.</span>{" "}
                Drafts: <span className="font-medium">{draftPhase}</span>{draftMeta ? ` (${draftMeta.completed} done)` : ""} · Diagrams: <span className="font-medium">{svgPhase}</span>{svgMeta ? ` (${svgMeta.completed} done)` : ""}
              </p>
            </section>
          ) : null}
          <div className={buildSettled ? "grid gap-6 xl:grid-cols-[3fr_2fr] xl:items-start" : ""}>
            {buildSettled ? (
              <RenderPanel
                plan={approvedPlan}
                drafts={drafts}
                svgs={Object.fromEntries(Object.entries(svgs).filter(([, v]) => v.svg && !v.error).map(([k, v]) => [k, v.svg]))}
                sources={research!.sources}
                linkedinPost={linkedinPost}
              />
            ) : null}
            <LinkedinPanel plan={approvedPlan} angle={form.summary.trim()} autoStart onPostUpdate={setLinkedinPost} />
          </div>
          {buildHasError ? (
            <p className="text-xs text-amber-700 -mt-4 mb-6">
              Some sections or diagrams failed. The PDF will render with placeholders where they are missing — use the per-panel regenerate buttons to retry just the failures.
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function ResearchPanel({ research }: { research: ResearchResponse }) {
  const userCount = research.sources.filter((s) => s.origin === "user").length;
  const searchCount = research.sources.length - userCount;
  return (
    <section className="mb-8">
      <div className="flex items-baseline justify-between mb-3 gap-3 flex-wrap">
        <h2 className="font-serif text-2xl">Research</h2>
        <p className="text-xs text-[var(--color-mute)]">
          {research.sources.length} source{research.sources.length === 1 ? "" : "s"}
          {userCount > 0 ? ` (${userCount} you supplied, ${searchCount} found by Tavily)` : " from Tavily"}
          {" · "}
          {(research.responseTimeMs / 1000).toFixed(1)}s
          {research.credits != null ? ` · ${research.credits} credit${research.credits === 1 ? "" : "s"}` : ""}
        </p>
      </div>
      {research.sources.length === 0 ? (
        <p className="text-sm text-[var(--color-mute)] italic">No sources returned. Try a more specific topic or add reference URLs.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {research.sources.map((s) => (
            <SourceCard key={s.url} source={s} />
          ))}
        </div>
      )}
    </section>
  );
}

function SourceCard({ source }: { source: ResearchSourceWire }) {
  const host = (() => {
    try { return new URL(source.url).host.replace(/^www\./, ""); } catch { return source.url; }
  })();
  return (
    <a
      href={source.url}
      target="_blank"
      rel="noreferrer"
      className="block bg-white rounded-lg border border-black/5 p-4 hover:border-[var(--color-amber)] transition"
    >
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <h3 className="font-serif text-lg leading-snug">{source.title}</h3>
        {source.origin === "user" ? (
          <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-[var(--color-ink)] text-[var(--color-cream)] shrink-0">You</span>
        ) : (
          <span className="text-xs text-[var(--color-mute)] shrink-0">score {source.score.toFixed(2)}</span>
        )}
      </div>
      <p className="text-sm text-[var(--color-mute)] line-clamp-3">{source.excerpt}</p>
      <p className="text-xs text-[var(--color-mute)] mt-2 flex items-center gap-2">
        <span className="truncate">{host}</span>
        {source.publishedDate ? <span className="shrink-0">· {source.publishedDate.slice(0, 10)}</span> : null}
      </p>
    </a>
  );
}
