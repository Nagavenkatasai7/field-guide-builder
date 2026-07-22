"use client";

import { useCallback, useEffect, useState } from "react";
import type { ConnectionTargetWire, ConnectionsResponse } from "@/app/api/connections/route";

/**
 * Connection pipeline (M16). Paste target companies (one per line, optionally
 * "Company | role"), get a drafted note per company anchored on the latest
 * guide. Copy + open LinkedIn's people search + send BY HAND — the app never
 * sends connection requests (LinkedIn ToS).
 */
export default function NetworkPanel() {
  const [items, setItems] = useState<ConnectionTargetWire[]>([]);
  const [noteMax, setNoteMax] = useState(280);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/connections", { cache: "no-store" });
      const j = (await res.json()) as ConnectionsResponse;
      setItems(j.items ?? []);
      setNoteMax(j.noteMaxChars ?? 280);
    } catch {
      /* transient */
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  function parseCompanies(): { company: string; roleHint?: string }[] {
    return input
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 10)
      .map((line) => {
        const [company, roleHint] = line.split("|").map((s) => s.trim());
        return roleHint ? { company, roleHint } : { company };
      })
      .filter((c) => c.company.length >= 2);
  }

  async function draft() {
    const companies = parseCompanies();
    if (companies.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/connections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ companies }),
      });
      const j = (await res.json()) as ConnectionsResponse & { error?: string };
      if (!res.ok) setError(j.error || `Drafting failed (${res.status})`);
      else {
        setItems(j.items ?? []);
        setInput("");
      }
    } catch {
      setError("Network error — try again.");
    } finally {
      setBusy(false);
    }
  }

  const fresh = items.filter((i) => i.status === "fresh");
  const rest = items.filter((i) => i.status !== "fresh");

  return (
    <div className="grid gap-6">
      <div className="bg-white rounded-lg border border-black/5 p-5 grid gap-2">
        <h2 className="font-serif text-xl">Connection pipeline</h2>
        <p className="text-xs text-[var(--color-mute)]">Paste target companies — one per line, optionally with a role after a pipe (e.g. <span className="font-mono">Anthropic | ML engineer</span>). You get a personalized note per company, anchored on your latest guide. Send each request yourself; the app never automates LinkedIn actions.</p>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={4}
          placeholder={"Company | role (one per line, up to 10)"}
          className="w-full text-sm border border-black/10 rounded p-2.5 bg-[var(--color-cream)] font-mono focus:outline-none focus:border-[var(--color-amber)]"
        />
        <div className="flex items-center gap-3 flex-wrap">
          <button type="button" onClick={() => void draft()} disabled={busy || parseCompanies().length === 0} className="text-sm bg-[var(--color-amber)] text-[var(--color-ink)] px-3 py-1.5 rounded font-medium disabled:opacity-50">{busy ? "Drafting…" : "Draft connection notes"}</button>
          {error ? <span className="text-xs text-red-700">{error}</span> : null}
        </div>
      </div>

      {fresh.length > 0 ? (
        <ul className="grid gap-3">
          {fresh.map((it) => <NoteCard key={it.id} item={it} noteMax={noteMax} onChanged={load} />)}
        </ul>
      ) : null}

      {rest.length > 0 ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-[var(--color-mute)]">Sent / dismissed ({rest.length})</summary>
          <ul className="grid gap-2 mt-2 opacity-70">
            {rest.map((it) => <NoteCard key={it.id} item={it} noteMax={noteMax} onChanged={load} />)}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function NoteCard({ item, noteMax, onChanged }: { item: ConnectionTargetWire; noteMax: number; onChanged: () => void }) {
  const [note, setNote] = useState(item.note);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  // Fixed LinkedIn origin + encoded user-supplied keywords — the only dynamic
  // part of the URL is the query string, so this can't redirect elsewhere.
  const searchUrl = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${item.company} ${item.roleHint ?? ""}`.trim())}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(note);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      window.alert("Clipboard unavailable — select and copy the text manually.");
    }
  }

  async function mark(status: "fresh" | "sent" | "dismissed") {
    setBusy(true);
    try {
      await fetch("/api/connections/item", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: item.id, status }),
      });
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  return (
    <li className="bg-white rounded-lg border border-black/5 p-4 grid gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-medium">{item.company}</span>
        {item.roleHint ? <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">{item.roleHint}</span> : null}
        {item.status !== "fresh" ? <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">{item.status}</span> : null}
      </div>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={noteMax}
        rows={3}
        className="w-full text-sm border border-black/10 rounded p-2.5 bg-[var(--color-cream)] focus:outline-none focus:border-[var(--color-amber)]"
      />
      <div className="flex items-center gap-3 flex-wrap text-xs">
        <span className="text-[11px] text-[var(--color-mute)] tabular-nums">{note.length}/{noteMax}</span>
        <button type="button" onClick={() => void copy()} className="bg-[var(--color-ink)] text-[var(--color-cream)] px-3 py-1.5 rounded">{copied ? "Copied ✓" : "Copy note"}</button>
        <a href={searchUrl} target="_blank" rel="noreferrer" className="underline text-[var(--color-ink)]">Find people at {item.company} ↗</a>
        {item.status === "fresh" ? (
          <>
            <button type="button" onClick={() => void mark("sent")} disabled={busy} className="underline text-green-700 disabled:opacity-50">Mark sent</button>
            <button type="button" onClick={() => void mark("dismissed")} disabled={busy} className="underline text-[var(--color-mute)] disabled:opacity-50">Dismiss</button>
          </>
        ) : (
          <button type="button" onClick={() => void mark("fresh")} disabled={busy} className="underline text-[var(--color-mute)] disabled:opacity-50">Move back</button>
        )}
      </div>
    </li>
  );
}
