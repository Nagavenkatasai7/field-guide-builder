// archiver v8 is pure ESM with named class exports (no callable default).
// @types/archiver is stale (still describes the old v6/v7 callable API), so
// import the v8 ZipArchive class with a local type assertion.
// @ts-expect-error — ZipArchive exists in archiver v8 runtime; types lag.
import { ZipArchive as ZipArchiveCls } from "archiver";

type ZipArchiveInstance = {
  on(event: "data", cb: (chunk: Buffer) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  on(event: "end", cb: () => void): void;
  append(data: Buffer, opts: { name: string }): void;
  finalize(): Promise<void>;
};

const ZipArchive = ZipArchiveCls as new (options?: { zlib?: { level?: number } }) => ZipArchiveInstance;

export type ZipFile = {
  /** Path inside the zip — supports forward slashes for folders */
  name: string;
  /** Buffer of file contents */
  data: Buffer;
};

/**
 * Builds a deterministic zip in memory. Used by /api/render to bundle
 * PDF + per-page PNGs + the LinkedIn caption into a single download.
 */
export async function buildZip(files: ZipFile[]): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const archive = new ZipArchive({ zlib: { level: 6 } });
    const chunks: Buffer[] = [];

    archive.on("data", (chunk: Buffer) => chunks.push(chunk));
    archive.on("error", (err: Error) => reject(err));
    archive.on("end", () => resolve(Buffer.concat(chunks)));

    for (const f of files) {
      archive.append(f.data, { name: f.name });
    }
    void archive.finalize();
  });
}
