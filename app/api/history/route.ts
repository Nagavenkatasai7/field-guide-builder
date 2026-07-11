import { listGenerations, storageEnabled } from "@/lib/storage";

export const runtime = "nodejs";
export const maxDuration = 30;

export type HistoryResponse =
  | { enabled: false; runs: [] }
  | { enabled: true; runs: Array<{
      id: string;
      createdAt: string;
      title: string;
      sourceCount: number;
      pageCount: number;
      pdfUrl: string;
      zipUrl: string;
      pdfBytes: number;
      zipBytes: number;
      linkedinChars: number | null;
    }> };

export async function GET() {
  if (!storageEnabled()) {
    const body: HistoryResponse = { enabled: false, runs: [] };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  try {
    const rows = await listGenerations(20);
    const body: HistoryResponse = {
      enabled: true,
      runs: rows.map((r) => ({
        id: r.id,
        createdAt: r.created_at,
        title: r.title,
        sourceCount: r.source_count,
        pageCount: r.page_count,
        pdfUrl: r.pdf_url,
        zipUrl: r.zip_url,
        pdfBytes: r.pdf_bytes,
        zipBytes: r.zip_bytes,
        linkedinChars: r.linkedin_chars,
      })),
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[history] failed: ${message}`);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
