"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { EngagementItemWire, EngagementResponse } from "@/app/api/engagement/route";

/**
 * Engagement cockpit (M13). Every action here is copy-and-open — the app
 * never posts comments/DMs itself (LinkedIn ToS). Flow per card: read the
 * draft, tweak if needed, Copy, Open ↗, paste by hand, Mark done.
 */
export default function EngagePanel() {
  const [items, setItems] = useState<EngagementItemWire[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/engagement", { cache: "no-store" });
      const j = (await res.json()) as EngagementResponse;
      setItems(j.items ?? []);
    } catch {
      /* transient */
    } finally {
      setLoaded(true);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  async function generate(force: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/engagement", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force }),
      });
      const j = (await res.json()) as EngagementResponse & { error?: string };
      if (!res.ok) setError(j.error || `Generation failed (${res.status})`);
      else setItems(j.items ?? []);
    } catch {
      setError("Network error — try again.");
    } finally {
      setBusy(false);
    }
  }

  const fresh = items.filter((i) => i.status === "fresh");
  const done = items.filter((i) => i.status !== "fresh");

  return (
    <div className="grid gap-6">
      <div className="bg-white rounded-lg border border-black/5 p-5">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="font-serif text-xl">Today&rsquo;s engagement targets</h2>
            <p className="text-xs text-[var(--color-mute)] mt-1">Fresh niche posts and articles worth a comment, each with a drafted starting point. Edit, copy, open, paste — 10 minutes covers the list. Nothing is ever posted automatically.</p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {items.length > 0 ? <button type="button" onClick={() => void generate(true)} disabled={busy} className="text-xs underline text-[var(--color-mute)] disabled:opacity-50">Regenerate</button> : null}
            <button type="button" onClick={() => void generate(false)} disabled={busy} className="text-sm bg-[var(--color-amber)] text-[var(--color-ink)] px-3 py-1.5 rounded font-medium disabled:opacity-50">
              {busy ? "Searching… ~1 min" : items.length > 0 ? "Refresh list" : "Find today's targets"}
            </button>
          </div>
        </div>
        {error ? <p className="text-sm mt-3 px-3 py-2 rounded bg-red-50 text-red-800 border border-red-200">{error}</p> : null}
        {loaded && items.length === 0 && !busy && !error ? <p className="text-sm text-[var(--color-mute)] italic mt-3">Nothing yet today — hit the button.</p> : null}
      </div>

      {fresh.length > 0 ? (
        <ul className="grid gap-3">
          {fresh.map((it) => <TargetCard key={it.id} item={it} onChanged={load} />)}
        </ul>
      ) : null}

      {done.length > 0 ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-[var(--color-mute)]">Done / dismissed today ({done.length})</summary>
          <ul className="grid gap-2 mt-2 opacity-70">
            {done.map((it) => <TargetCard key={it.id} item={it} onChanged={load} />)}
          </ul>
        </details>
      ) : null}

      <ReplyDrafter />
    </div>
  );
}

function TargetCard({ item, onChanged }: { item: EngagementItemWire; onChanged: () => void }) {
  const [comment, setComment] = useState(item.draftComment);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const linkRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    // Ref-based href with a scheme guard (repo convention — see SafeLink):
    // engagement URLs come from search results, so only plain https ever
    // lands on the anchor.
    if (linkRef.current && item.url.startsWith("https://")) linkRef.current.href = item.url;
  }, [item.url]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(comment);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      window.alert("Clipboard unavailable — select and copy the text manually.");
    }
  }

  async function mark(status: "fresh" | "used" | "dismissed") {
    setBusy(true);
    try {
      await fetch("/api/engagement/item", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: item.id, status }),
      });
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  const badge = item.source === "linkedin"
    ? { label: "LinkedIn post", cls: "bg-sky-100 text-sky-800" }
    : { label: "Article", cls: "bg-emerald-100 text-emerald-800" };

  return (
    <li className="bg-white rounded-lg border border-black/5 p-4 grid gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0 ${badge.cls}`}>{badge.label}</span>
        <span className="text-sm font-medium min-w-0 truncate">{item.title}</span>
        {item.status !== "fresh" ? <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 shrink-0">{item.status}</span> : null}
      </div>
      {item.snippet ? <p className="text-xs text-[var(--color-mute)] line-clamp-2">{item.snippet}</p> : null}
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        rows={3}
        className="w-full text-sm border border-black/10 rounded p-2.5 bg-[var(--color-cream)] focus:outline-none focus:border-[var(--color-amber)]"
      />
      <div className="flex items-center gap-3 flex-wrap text-xs">
        <button type="button" onClick={() => void copy()} className="bg-[var(--color-ink)] text-[var(--color-cream)] px-3 py-1.5 rounded">{copied ? "Copied ✓" : "Copy comment"}</button>
        <a ref={linkRef} target="_blank" rel="noreferrer" className="underline text-[var(--color-ink)]">Open ↗</a>
        {item.status === "fresh" ? (
          <>
            <button type="button" onClick={() => void mark("used")} disabled={busy} className="underline text-green-700 disabled:opacity-50">Mark done</button>
            <button type="button" onClick={() => void mark("dismissed")} disabled={busy} className="underline text-[var(--color-mute)] disabled:opacity-50">Dismiss</button>
          </>
        ) : (
          <button type="button" onClick={() => void mark("fresh")} disabled={busy} className="underline text-[var(--color-mute)] disabled:opacity-50">Move back</button>
        )}
      </div>
    </li>
  );
}

function ReplyDrafter() {
  const [theirComment, setTheirComment] = useState("");
  const [postTopic, setPostTopic] = useState("");
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function draft() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/engagement/reply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ theirComment, postTopic: postTopic.trim() || undefined }),
      });
      const j = (await res.json()) as { reply?: string; error?: string };
      if (!res.ok || !j.reply) setError(j.error || "Drafting failed — try again.");
      else setReply(j.reply);
    } catch {
      setError("Network error — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(reply);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      window.alert("Clipboard unavailable — select and copy the text manually.");
    }
  }

  return (
    <div className="bg-white rounded-lg border border-black/5 p-5 grid gap-2">
      <h2 className="font-serif text-xl">Reply drafter</h2>
      <p className="text-xs text-[var(--color-mute)]">Someone commented on your post? Paste it here for a reply draft. Replying inside the first hour is the single biggest reach lever.</p>
      <input
        value={postTopic}
        onChange={(e) => setPostTopic(e.target.value)}
        maxLength={300}
        placeholder="Your post's topic (optional, sharpens the reply)"
        className="w-full text-sm border border-black/10 rounded p-2.5 bg-[var(--color-cream)] focus:outline-none focus:border-[var(--color-amber)]"
      />
      <textarea
        value={theirComment}
        onChange={(e) => setTheirComment(e.target.value)}
        rows={3}
        maxLength={2000}
        placeholder="Paste the comment you received…"
        className="w-full text-sm border border-black/10 rounded p-2.5 bg-[var(--color-cream)] focus:outline-none focus:border-[var(--color-amber)]"
      />
      <div className="flex items-center gap-3 flex-wrap">
        <button type="button" onClick={() => void draft()} disabled={busy || theirComment.trim().length < 2} className="text-sm bg-[var(--color-ink)] text-[var(--color-cream)] px-3 py-1.5 rounded disabled:opacity-50">{busy ? "Drafting…" : "Draft reply"}</button>
        {error ? <span className="text-xs text-red-700">{error}</span> : null}
      </div>
      {reply ? (
        <div className="grid gap-2 mt-1">
          <textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={3} className="w-full text-sm border border-black/10 rounded p-2.5 bg-[var(--color-cream)]" />
          <div><button type="button" onClick={() => void copy()} className="text-xs bg-[var(--color-ink)] text-[var(--color-cream)] px-3 py-1.5 rounded">{copied ? "Copied ✓" : "Copy reply"}</button></div>
        </div>
      ) : null}
    </div>
  );
}
