import { appBaseUrl } from "@/lib/approval";
import { withUtm } from "@/lib/repurpose";
import { listPostedRuns, storageEnabled } from "@/lib/storage";
import { AUTHOR } from "@/lib/identity";

export const runtime = "nodejs";
export const maxDuration = 30;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/**
 * PUBLIC RSS 2.0 feed of posted guides (allow-listed in proxy.ts) — the
 * standards-flavored sibling of /api/feed for readers and newsletter tools
 * that speak RSS. Same public-only content, same UTM tagging.
 */
export async function GET(): Promise<Response> {
  const site = appBaseUrl();
  const runs = storageEnabled() ? await listPostedRuns(30) : [];
  const items = runs
    .map((r) => {
      const title = r.plan_title ?? r.topic ?? "Field guide";
      const link = r.linkedin_post_url ?? (r.pdf_url ? withUtm(r.pdf_url, "rss") : site);
      const desc = r.caption ? r.caption.slice(0, 800) : "";
      const pub = new Date(r.posted_at ?? r.created_at).toUTCString();
      const pdf = r.pdf_url ? `\n      <enclosure url="${esc(withUtm(r.pdf_url, "rss"))}" type="application/pdf" length="0"/>` : "";
      return `    <item>
      <title>${esc(title)}</title>
      <link>${esc(link)}</link>
      <guid isPermaLink="false">${esc(r.id)}</guid>
      <pubDate>${pub}</pubDate>
      <description>${esc(desc)}</description>${pdf}
    </item>`;
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${esc(`${AUTHOR.brand} — daily field guides`)}</title>
    <link>${esc(site)}</link>
    <description>${esc(`Illustrated field guides by ${AUTHOR.name}, published daily to LinkedIn.`)}</description>
${items}
  </channel>
</rss>`;
  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, s-maxage=900, stale-while-revalidate=3600",
    },
  });
}
