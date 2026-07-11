"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PlanT } from "@/lib/plan-schema";

type Props = {
  plan: PlanT;
  angle?: string;
  autoStart?: boolean;
  /** Receives the latest caption text (including user edits) so the parent can pass it into the render step. */
  onPostUpdate?: (text: string) => void;
};

type Meta = {
  model: string;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  chars: number;
};

type Phase = "idle" | "loading" | "ready" | "error";

const MAX_CHARS = 2500;
const WARN_CHARS = 2200;
const SHARE_BASE = "https://www.linkedin.com/feed/?shareActive=true&text=";

export default function LinkedinPanel({ plan, angle, autoStart, onPostUpdate }: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [text, setText] = useState<string>("");
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const startedRef = useRef(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = useCallback(async () => {
    setPhase("loading");
    setError(null);
    setMeta(null);
    setCopied(false);
    try {
      const res = await fetch("/api/linkedin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan, angle }),
      });
      const data = (await res.json().catch(() => ({}))) as { post?: string; meta?: Meta; error?: string };
      if (!res.ok || !data.post) {
        setError(data.error || `LinkedIn request failed (${res.status})`);
        setPhase("error");
        return;
      }
      setText(data.post);
      if (data.meta) setMeta(data.meta);
      setPhase("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
      setPhase("error");
    }
  }, [plan, angle]);

  useEffect(() => {
    if (autoStart && !startedRef.current) {
      startedRef.current = true;
      void run();
    }
  }, [autoStart, run]);

  useEffect(() => {
    onPostUpdate?.(text);
  }, [text, onPostUpdate]);

  const charCount = text.length;
  const counterColor = useMemo(() => {
    if (charCount >= MAX_CHARS) return "text-red-700";
    if (charCount >= WARN_CHARS) return "text-amber-700";
    return "text-[var(--color-mute)]";
  }, [charCount]);

  const shareUrl = useMemo(() => `${SHARE_BASE}${encodeURIComponent(text.slice(0, MAX_CHARS))}`, [text]);

  // Imperative href binding so the LinkedIn share URL doesn't appear as a
  // useState value flowing into a JSX href attribute (Snyk flags that
  // structurally even with the hardcoded https://www.linkedin.com/ prefix).
  const shareRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (!shareRef.current) return;
    if (shareUrl.startsWith("https://www.linkedin.com/")) {
      shareRef.current.href = shareUrl;
    } else {
      shareRef.current.removeAttribute("href");
    }
  }, [shareUrl]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      // ignore; if Clipboard API unavailable user can select manually
    }
  }

  return (
    <section className="mb-8">
      <div className="flex items-baseline justify-between mb-3 gap-3 flex-wrap">
        <h2 className="font-serif text-2xl">LinkedIn caption</h2>
        {phase === "loading" ? (
          <p className="text-xs text-[var(--color-mute)]">writing…</p>
        ) : null}
        {phase === "ready" && meta ? (
          <p className="text-xs text-[var(--color-mute)] tabular-nums">
            {meta.model} · {meta.tokensIn} in / {meta.tokensOut} out · {(meta.durationMs / 1000).toFixed(1)}s
          </p>
        ) : null}
      </div>

      {phase === "idle" ? (
        <button type="button" onClick={run} className="bg-[var(--color-ink)] text-[var(--color-cream)] px-5 py-2.5 rounded font-medium">
          Generate caption
        </button>
      ) : null}

      {phase === "loading" ? (
        <div className="bg-white rounded-lg border border-black/5 p-6 flex items-center gap-3">
          <span className="inline-block w-4 h-4 border-2 border-[var(--color-amber)] border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-[var(--color-mute)]">Drafting a 1500–2200 character post in your voice…</p>
        </div>
      ) : null}

      {phase === "error" ? (
        <div className="bg-white rounded-lg border border-red-200 p-6">
          <p className="text-sm text-red-700 mb-3">{error}</p>
          <button type="button" onClick={run} className="bg-[var(--color-ink)] text-[var(--color-cream)] px-4 py-2 rounded text-sm">Try again</button>
        </div>
      ) : null}

      {phase === "ready" ? (
        <div className="bg-white rounded-lg border border-black/5 p-4 grid gap-3">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={18}
            className="w-full text-sm font-sans border border-black/10 rounded px-3 py-2 leading-relaxed focus:outline-none focus:border-[var(--color-amber)] resize-y"
          />
          <div className="flex items-center gap-3 flex-wrap">
            <span className={`text-xs tabular-nums ${counterColor}`}>
              {charCount} / {MAX_CHARS} chars
            </span>
            <div className="grow" />
            <button
              type="button"
              onClick={copy}
              disabled={charCount === 0}
              className="bg-[var(--color-ink)] text-[var(--color-cream)] px-4 py-2 rounded text-sm font-medium disabled:opacity-50"
            >
              {copied ? "Copied ✓" : "Copy to clipboard"}
            </button>
            <a
              ref={shareRef}
              target="_blank"
              rel="noreferrer"
              className="bg-[var(--color-amber)] text-[var(--color-ink)] px-4 py-2 rounded text-sm font-medium"
            >
              Open LinkedIn share
            </a>
            <button
              type="button"
              onClick={run}
              className="text-xs underline text-[var(--color-mute)] hover:text-[var(--color-text-body)]"
            >
              Regenerate
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
