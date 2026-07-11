/**
 * SVG validator — regex-based, no DOM library.
 *
 * Previous implementation used jsdom but its transitive dependency on
 * @exodus/bytes (ESM) breaks Vercel's serverless bundle with an
 * ERR_REQUIRE_ESM crash on cold start. We only need a handful of cheap
 * structural checks plus tag stripping, which all reduce to regex.
 *
 * Security model: the validator's job is to reject obvious model failures
 * and strip obviously-dangerous nodes. Final defense-in-depth lives at the
 * rendering layer (Puppeteer for PDF, dangerouslySetInnerHTML for previews —
 * both run in our own controlled context, never user-untrusted input).
 */

const FORBIDDEN_TAGS = ["script", "foreignObject", "image", "style", "iframe", "audio", "video", "object"];

export type SvgValidation =
  | { ok: true; svg: string; viewBox: string; tagCount: number }
  | { ok: false; reason: string };

function stripFences(text: string): string {
  return text
    .replace(/^[\s​]*```(?:svg|xml|html)?\s*\n?/i, "")
    .replace(/\n?```[\s​]*$/i, "")
    .trim();
}

function extractSvg(text: string): string {
  const start = text.search(/<svg\b/i);
  const end = text.lastIndexOf("</svg>");
  if (start < 0 || end <= start) return text;
  return text.slice(start, end + "</svg>".length);
}

function stripForbiddenTags(svg: string): string {
  let out = svg;
  for (const tag of FORBIDDEN_TAGS) {
    // Block element with content: <tag ...>...</tag> (case-insensitive, dotall via [\s\S])
    const blockRe = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi");
    // Self-closing: <tag ... />
    const selfRe = new RegExp(`<${tag}\\b[^>]*\\/>`, "gi");
    // Third pass: any orphan opening/closing tag left over (e.g. an
    // UNTERMINATED <script src=...> that the block regex can't match).
    const bareRe = new RegExp(`<\\/?${tag}\\b[^>]*>?`, "gi");
    out = out.replace(blockRe, "").replace(selfRe, "").replace(bareRe, "");
  }
  return out;
}

function stripExternalHrefs(svg: string): string {
  // Remove href / xlink:href attributes that point at http(s)/data/file/javascript URLs.
  // Keep relative / fragment hrefs (e.g. href="#gradient") since those are SVG-internal.
  return svg.replace(
    /\s(?:xlink:)?href\s*=\s*(['"])\s*(?:https?:|data:|file:|javascript:)[^'"]*\1/gi,
    "",
  );
}

function stripEventAttrs(svg: string): string {
  // SVG elements fire inline handlers too (<rect onload=…>) — these previews
  // are injected via dangerouslySetInnerHTML, so strip every on* attribute.
  return svg.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
}

function stripRootDimensions(svg: string): string {
  // Strip width/height attributes ONLY on the root <svg> opening tag.
  // Doing so on every element would damage <rect width="..">. The pattern must
  // span the FULL opening tag (a lazy `[^>]*?` with nothing after it matches
  // zero characters and silently does nothing).
  return svg.replace(/^<svg\b[^>]*>/i, (open) => {
    return open.replace(/\swidth\s*=\s*(['"])[^'"]*\1/i, "").replace(/\sheight\s*=\s*(['"])[^'"]*\1/i, "");
  });
}

function ensureXmlns(svg: string): string {
  if (/<svg\b[^>]*\sxmlns\s*=/i.test(svg)) return svg;
  return svg.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
}

function getViewBox(svg: string): string | null {
  // Commas are spec-valid separators in a viewBox — accept and normalize them.
  const m = svg.match(/<svg\b[^>]*\sviewBox\s*=\s*(['"])([-\d.,\s]+)\1/i);
  if (!m) return null;
  const normalized = m[2].trim().replace(/,/g, " ").replace(/\s+/g, " ");
  const parts = normalized.split(" ").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n)) || parts[2] <= 0 || parts[3] <= 0) return null;
  return normalized;
}

function countTags(svg: string): number {
  // Open + self-closing tags. Closing tags don't count toward element count.
  const matches = svg.match(/<[a-zA-Z][^>]*?>/g);
  return matches ? matches.length : 0;
}

export function validateSvg(raw: string): SvgValidation {
  const cleaned = extractSvg(stripFences(raw));
  if (!cleaned || !/<svg\b/i.test(cleaned)) return { ok: false, reason: "no <svg> element found" };
  if (!/<\/svg>\s*$/.test(cleaned.trim())) return { ok: false, reason: "no closing </svg> tag" };

  const viewBox = getViewBox(cleaned);
  if (!viewBox) return { ok: false, reason: "missing or malformed viewBox" };

  let out = cleaned;
  out = stripForbiddenTags(out);
  out = stripExternalHrefs(out);
  out = stripEventAttrs(out);
  out = stripRootDimensions(out);
  out = ensureXmlns(out);

  const tagCount = countTags(out);
  if (tagCount < 5) return { ok: false, reason: `too few elements (${tagCount}) — looks empty` };

  return { ok: true, svg: out, viewBox, tagCount };
}
