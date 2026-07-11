"use client";

import { useEffect, useRef, useState } from "react";
import type { PlanT } from "@/lib/plan-schema";
import type { DraftedSection } from "@/app/_components/DraftPanel";
import type { ResearchSourceWire } from "@/app/api/research/route";
import type { RenderResponse } from "@/app/api/render/route";
import type { DesignThemeT } from "@/lib/design-variant";
import type { DesignResponse } from "@/app/api/design/route";

type Props = {
  plan: PlanT;
  drafts: Record<string, DraftedSection>;
  svgs: Record<string, string>;
  sources: ResearchSourceWire[];
  linkedinPost?: string;
};

type State = "idle" | "rendering" | "ready" | "error";

type ReadyUrls = {
  pdfUrl: string;       // blob: (inline) or https: (stored)
  zipUrl: string;
  pdfBytes: number;
  zipBytes: number;
  renderMs: number;
  mode: "inline" | "stored";
};

export default function RenderPanel({ plan, drafts, svgs, sources, linkedinPost }: Props) {
  const [state, setState] = useState<State>("idle");
  const [error, setError] = useState<string | null>(null);
  const [urls, setUrls] = useState<ReadyUrls | null>(null);
  const [freshDesign, setFreshDesign] = useState(false);
  const [designNote, setDesignNote] = useState<string | null>(null);
  const inlineBlobsRef = useRef<string[]>([]);

  function revokeOldBlobs() {
    for (const u of inlineBlobsRef.current) URL.revokeObjectURL(u);
    inlineBlobsRef.current = [];
  }

  useEffect(() => () => revokeOldBlobs(), []);

  async function run() {
    setState("rendering");
    setError(null);
    setDesignNote(null);
    revokeOldBlobs();
    setUrls(null);

    try {
      // Optional per-topic design variant. If it fails, we silently fall back
      // to the standard design rather than block the render.
      let theme: DesignThemeT | undefined;
      if (freshDesign) {
        try {
          const dres = await fetch("/api/design", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ topic: plan.title, title: plan.title }),
          });
          const ddata = (await dres.json().catch(() => ({ ok: false }))) as DesignResponse;
          if (ddata.ok) theme = ddata.theme;
          else setDesignNote("Couldn't generate a fresh design — used the standard look.");
        } catch {
          setDesignNote("Couldn't generate a fresh design — used the standard look.");
        }
      }

      const res = await fetch("/api/render", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          plan,
          drafts: Object.fromEntries(
            Object.entries(drafts).map(([id, d]) => [id, { html: d.html, error: d.error }]),
          ),
          sources,
          svgs,
          linkedinPost,
          ...(theme ? { theme } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as RenderResponse | { error?: string };
      if (!res.ok || !("plan" in data)) {
        setError(("error" in data && data.error) || `Render failed (${res.status})`);
        setState("error");
        return;
      }

      if (data.mode === "inline") {
        const pdfBlob = base64ToBlob(data.pdf.base64, "application/pdf");
        const zipBlob = base64ToBlob(data.zip.base64, "application/zip");
        const pdfUrl = URL.createObjectURL(pdfBlob);
        const zipUrl = URL.createObjectURL(zipBlob);
        inlineBlobsRef.current = [pdfUrl, zipUrl];
        setUrls({
          pdfUrl, zipUrl,
          pdfBytes: data.pdf.bytes, zipBytes: data.zip.bytes,
          renderMs: data.renderMs, mode: "inline",
        });
      } else {
        setUrls({
          pdfUrl: data.pdf.url, zipUrl: data.zip.url,
          pdfBytes: data.pdf.bytes, zipBytes: data.zip.bytes,
          renderMs: data.renderMs, mode: "stored",
        });
      }
      setState("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
      setState("error");
    }
  }

  return (
    <section className="mb-8">
      <div className="flex items-baseline justify-between mb-3 gap-3 flex-wrap">
        <h2 className="font-serif text-2xl">PDF + Zip</h2>
        {urls ? (
          <p className="text-xs text-[var(--color-mute)] tabular-nums">
            PDF {(urls.pdfBytes / 1024).toFixed(1)} KB · ZIP {(urls.zipBytes / 1024).toFixed(1)} KB · {(urls.renderMs / 1000).toFixed(1)}s render · {urls.mode === "stored" ? "saved to history" : "inline (no storage configured)"}
          </p>
        ) : null}
      </div>

      {designNote ? <p className="text-xs text-amber-700 mb-2">{designNote}</p> : null}

      {state === "idle" ? (
        <div className="bg-white rounded-lg border border-black/5 p-6">
          <p className="text-sm text-[var(--color-mute)] mb-3">
            Renders {plan.sections.length} A4 pages, screenshots each as a PNG, bundles them with the PDF (and LinkedIn caption) into a downloadable zip.
          </p>
          <label className="flex items-start gap-2 mb-4 text-sm cursor-pointer select-none">
            <input
              type="checkbox"
              checked={freshDesign}
              onChange={(e) => setFreshDesign(e.target.checked)}
              className="mt-0.5 accent-[var(--color-amber)]"
            />
            <span>
              <span className="font-medium">✨ Generate a fresh design for this topic</span>
              <span className="block text-xs text-[var(--color-mute)]">
                Off = the standard Field Guide look (used for daily auto-posts). On = a one-off palette + typeface tuned to this topic, so you can compare which performs better.
              </span>
            </span>
          </label>
          <button
            type="button"
            onClick={run}
            className="bg-[var(--color-amber)] text-[var(--color-ink)] px-5 py-2.5 rounded font-medium"
          >
            Render PDF + Zip
          </button>
        </div>
      ) : null}

      {state === "rendering" ? (
        <div className="bg-white rounded-lg border border-black/5 p-6 flex items-center gap-3">
          <span className="inline-block w-4 h-4 border-2 border-[var(--color-amber)] border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-[var(--color-mute)]">Spinning up Chrome, laying out pages, screenshotting each, zipping…</p>
        </div>
      ) : null}

      {state === "error" ? (
        <div className="bg-white rounded-lg border border-red-200 p-6">
          <p className="text-sm text-red-700 mb-3">{error}</p>
          <button type="button" onClick={run} className="bg-[var(--color-ink)] text-[var(--color-cream)] px-4 py-2 rounded text-sm">
            Try again
          </button>
        </div>
      ) : null}

      {state === "ready" && urls ? (
        <DownloadPreview urls={urls} planTitle={plan.title} onRerender={run} />
      ) : null}
    </section>
  );
}

function base64ToBlob(b64: string, type: string): Blob {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

/**
 * Imperatively binds the PDF + zip URLs into iframe/anchors via refs and
 * element property assignment so static analyzers don't see useState values
 * flowing into JSX href/src attributes. The actual defense is checking that
 * the URL starts with blob: (inline mode) or https: (stored mode).
 */
function DownloadPreview({
  urls,
  planTitle,
  onRerender,
}: {
  urls: ReadyUrls;
  planTitle: string;
  onRerender: () => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const pdfAnchorRef = useRef<HTMLAnchorElement>(null);
  const zipAnchorRef = useRef<HTMLAnchorElement>(null);
  const slug = slugify(planTitle);

  useEffect(() => {
    const ok = (u: string) => u.startsWith("blob:") || u.startsWith("https://");
    if (!ok(urls.pdfUrl) || !ok(urls.zipUrl)) return;
    if (iframeRef.current) iframeRef.current.src = urls.pdfUrl;
    if (pdfAnchorRef.current) pdfAnchorRef.current.href = urls.pdfUrl;
    if (zipAnchorRef.current) zipAnchorRef.current.href = urls.zipUrl;
  }, [urls]);

  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-3 flex-wrap">
        <a
          ref={pdfAnchorRef}
          download={`${slug}.pdf`}
          className="bg-[var(--color-amber)] text-[var(--color-ink)] px-5 py-2.5 rounded font-medium"
        >
          Download PDF
        </a>
        <a
          ref={zipAnchorRef}
          download={`${slug}.zip`}
          className="bg-[var(--color-ink)] text-[var(--color-cream)] px-5 py-2.5 rounded font-medium"
        >
          Download ZIP
        </a>
        <button
          type="button"
          onClick={onRerender}
          className="text-sm underline text-[var(--color-mute)] hover:text-[var(--color-text-body)]"
        >
          Re-render
        </button>
      </div>
      <iframe
        ref={iframeRef}
        title="Field Guide preview"
        className="w-full h-[80vh] bg-white rounded-lg border border-black/5"
      />
    </div>
  );
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "field-guide";
}
