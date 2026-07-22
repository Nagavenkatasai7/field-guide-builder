"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { ApprovalPreviewResponse } from "@/app/api/approval/preview/route";

type Phase =
  | { kind: "loading" }
  | { kind: "invalid" }
  | { kind: "ready"; preview: ApprovalPreviewResponse }
  | { kind: "submitting"; preview: ApprovalPreviewResponse; action: "approve" | "skip" }
  | { kind: "done"; message: string; postUrl?: string; tone: "good" | "warn" };

type DecideResponse = { status?: string; postUrl?: string; error?: string; reasons?: string[] };

export default function ApprovalClient() {
  const token = useSearchParams().get("token") ?? "";
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [take, setTake] = useState("");
  const [caption, setCaption] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const pdfRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!token) {
        setPhase({ kind: "invalid" });
        return;
      }
      try {
        const res = await fetch(`/api/approval/preview?token=${encodeURIComponent(token)}`, { cache: "no-store" });
        if (!res.ok) {
          if (!cancelled) setPhase({ kind: "invalid" });
          return;
        }
        const preview = (await res.json()) as ApprovalPreviewResponse;
        if (!cancelled) {
          setCaption(preview.caption ?? "");
          setPhase({ kind: "ready", preview });
        }
      } catch {
        if (!cancelled) setPhase({ kind: "invalid" });
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [token]);

  const preview = phase.kind === "ready" || phase.kind === "submitting" ? phase.preview : null;

  useEffect(() => {
    // Ref-based href assignment (repo convention — see RenderPanel) with a
    // scheme guard so only real https artifact URLs ever land on the anchor.
    if (pdfRef.current && preview?.pdfUrl && preview.pdfUrl.startsWith("https://")) {
      pdfRef.current.href = preview.pdfUrl;
    }
  }, [preview?.pdfUrl]);

  async function decide(action: "approve" | "skip") {
    if (phase.kind !== "ready") return;
    if (action === "skip" && !window.confirm("Skip today's post? Nothing will be published.")) return;
    setFormError(null);
    setPhase({ kind: "submitting", preview: phase.preview, action });
    try {
      const res = await fetch("/api/approval/decide", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          action === "approve"
            ? { token, action, personalTake: take.trim() || undefined, caption }
            : { token, action },
        ),
      });
      const j = (await res.json().catch(() => ({}))) as DecideResponse;
      if (!res.ok) {
        const detail = j.reasons?.length ? `${j.error}: ${j.reasons.join("; ")}` : (j.error || `Request failed (${res.status})`);
        if (res.status === 400) {
          // Fixable on the page — return to the form with the reasons shown.
          setFormError(detail);
          setPhase({ kind: "ready", preview: phase.preview });
        } else {
          setPhase({ kind: "done", message: detail, tone: "warn" });
        }
        return;
      }
      if (j.status === "posted") {
        setPhase({ kind: "done", message: "Posted to LinkedIn. Go reply to the first comments — the first hour decides reach.", postUrl: j.postUrl, tone: "good" });
      } else if (j.status === "skipped") {
        setPhase({ kind: "done", message: "Skipped. Nothing was posted today.", tone: "good" });
      } else {
        setPhase({ kind: "done", message: `Result: ${j.status ?? "unknown"}. ${j.error ?? "Check the dashboard for details."}`, tone: "warn" });
      }
    } catch {
      setFormError("Network error — the decision was not submitted. Try again.");
      setPhase({ kind: "ready", preview: phase.preview });
    }
  }

  return (
    <main className="min-h-screen px-6 py-10 max-w-3xl mx-auto">
      <header className="border-b border-black/10 pb-4 mb-6">
        <p className="text-[11px] uppercase tracking-[0.25em] text-[var(--color-mute)]">Field Guide Builder · Approval</p>
        <h1 className="font-serif text-3xl leading-tight mt-1">Today&rsquo;s post is waiting for you</h1>
      </header>

      {phase.kind === "loading" ? <p className="text-sm text-[var(--color-mute)]">Checking your link…</p> : null}

      {phase.kind === "invalid" ? (
        <div className="bg-white rounded-lg border border-black/5 p-5">
          <p className="text-sm">This approval link is invalid, already used, or expired.</p>
          <p className="text-xs text-[var(--color-mute)] mt-2">If the window lapsed, the day was safely skipped — nothing was posted. You can re-issue a link from the dashboard&rsquo;s Posts tab while a run is still awaiting approval.</p>
        </div>
      ) : null}

      {phase.kind === "done" ? (
        <div className={`rounded-lg border p-5 ${phase.tone === "good" ? "bg-green-50 border-green-200 text-green-900" : "bg-amber-50 border-amber-200 text-amber-900"}`}>
          <p className="text-sm">{phase.message}</p>
          {phase.postUrl && phase.postUrl.startsWith("https://www.linkedin.com/") ? (
            <p className="text-sm mt-2"><a href={phase.postUrl} target="_blank" rel="noreferrer" className="underline font-medium">View the post on LinkedIn ↗</a></p>
          ) : null}
        </div>
      ) : null}

      {preview && (phase.kind === "ready" || phase.kind === "submitting") ? (
        <div className="grid gap-5">
          <div className="bg-white rounded-lg border border-black/5 p-5">
            <p className="text-xs uppercase tracking-wider text-[var(--color-mute)] mb-1">Topic</p>
            <p className="font-serif text-xl">{preview.planTitle || preview.topic || "Field guide"}</p>
            {preview.topic && preview.planTitle ? <p className="text-xs text-[var(--color-mute)] mt-1">{preview.topic}</p> : null}
            <div className="flex items-center gap-4 mt-3 text-xs">
              {preview.pdfUrl ? <a ref={pdfRef} target="_blank" rel="noreferrer" className="underline text-[var(--color-ink)] font-medium">Open the PDF ↗</a> : null}
              {preview.pageCount ? <span className="text-[var(--color-mute)]">{preview.pageCount} pages</span> : null}
              {preview.expiresAt ? <span className="text-[var(--color-mute)]">Window closes {new Date(preview.expiresAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span> : null}
            </div>
          </div>

          <div className="bg-white rounded-lg border border-black/5 p-5 grid gap-2">
            <label htmlFor="take" className="text-sm font-medium">Your take <span className="font-normal text-[var(--color-mute)]">(optional, recommended — it opens the post)</span></label>
            <textarea
              id="take"
              value={take}
              onChange={(e) => setTake(e.target.value)}
              maxLength={preview.personalTakeMaxChars}
              rows={3}
              placeholder="Two or three sentences in your own voice: an opinion, something you tried, what surprised you."
              className="w-full text-sm border border-black/10 rounded p-3 bg-[var(--color-cream)] focus:outline-none focus:border-[var(--color-amber)]"
            />
            <p className="text-[11px] text-[var(--color-mute)] text-right tabular-nums">{take.length}/{preview.personalTakeMaxChars}</p>
          </div>

          <div className="bg-white rounded-lg border border-black/5 p-5 grid gap-2">
            <label htmlFor="caption" className="text-sm font-medium">Generated caption <span className="font-normal text-[var(--color-mute)]">(edit freely)</span></label>
            <textarea
              id="caption"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              rows={14}
              className="w-full text-sm border border-black/10 rounded p-3 bg-[var(--color-cream)] font-sans focus:outline-none focus:border-[var(--color-amber)]"
            />
            <p className="text-[11px] text-[var(--color-mute)] text-right tabular-nums">{caption.length} chars</p>
          </div>

          {formError ? <p className="text-sm px-3 py-2 rounded bg-red-50 text-red-800 border border-red-200">{formError}</p> : null}

          <div className="flex items-center gap-3 flex-wrap">
            <button
              type="button"
              onClick={() => void decide("approve")}
              disabled={phase.kind === "submitting"}
              className="text-sm bg-[var(--color-amber)] text-[var(--color-ink)] px-5 py-2.5 rounded font-medium disabled:opacity-50"
            >
              {phase.kind === "submitting" && phase.action === "approve" ? "Posting… (can take a minute)" : "Approve & post to LinkedIn"}
            </button>
            <button
              type="button"
              onClick={() => void decide("skip")}
              disabled={phase.kind === "submitting"}
              className="text-sm underline text-[var(--color-mute)] disabled:opacity-50"
            >
              {phase.kind === "submitting" && phase.action === "skip" ? "Skipping…" : "Skip today"}
            </button>
          </div>
          <p className="text-[11px] text-[var(--color-mute)]">Your take is prepended to the caption. Everything still passes the safety guard (links and @mentions are stripped, length is enforced) before posting.</p>
        </div>
      ) : null}
    </main>
  );
}
