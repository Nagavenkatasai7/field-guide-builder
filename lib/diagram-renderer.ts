import type { InfographicT } from "@/lib/plan-schema";
import type { DiagramSpecT, DiagramNodeT, DiagramEdgeT } from "@/lib/diagram-schema";

/**
 * Deterministic SVG renderer for diagram specs.
 *
 * All geometry — box sizing, text wrapping, grid placement, arrow routing,
 * scale-to-fit — is computed here in code, so the output SVG is valid by
 * construction: no overlapping text, no clipped boxes, no arrows to nowhere,
 * and a paper background card so the diagram stays readable on dark pages.
 * The LLM only ever supplies the spec (lib/diagram-schema.ts).
 */

// Palette — must match templates/field-guide.css tokens.
const INK = "#0B1027";
const AMBER = "#E8A317";
const AMBER_DEEP = "#B07700";
const CREAM = "#F4EEDE";
const PAPER = "#FAF6EA";
const TEXT = "#14172E";
const MUTE = "#6B6B6B";

const FRAUNCES = "Fraunces, Georgia, serif";
const GEIST = "Geist, ui-sans-serif, system-ui, sans-serif";

type Canvas = { w: number; h: number };
const CANVAS: Record<InfographicT["layout"], Canvas> = {
  landscape: { w: 1000, h: 600 },
  portrait: { w: 700, h: 900 },
};

// Type sizes are tuned for PRINT: the landscape canvas (1000 units) maps to
// ~178mm on the A4 page, so 1 unit ≈ 0.18mm — sublabels below ~12 units would
// print under 6pt and become illegible.
const MARGIN_X = 36;
const MARGIN_Y = 30;
const GAP_X = 46;
const LABEL_SIZE = 18;
const SUB_SIZE = 12.5;
const NOTE_SIZE = 13;

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Rough per-character width estimate (em fraction) — conservative on purpose. */
function charEm(c: string): number {
  if (/[iIljt.,'’`|!:;()[\]]/.test(c)) return 0.34;
  if (/[mwMW@]/.test(c)) return 0.92;
  if (/[A-HJ-Z0-9]/.test(c)) return 0.72;
  if (c === " ") return 0.3;
  return 0.56;
}

function estWidth(text: string, fontSize: number): number {
  let em = 0;
  for (const c of text) em += charEm(c);
  return em * fontSize;
}

/** Greedy word wrap with hard-split for over-long words and ellipsized overflow. */
function wrapText(text: string, maxWidth: number, fontSize: number, maxLines: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  const fits = (s: string) => estWidth(s, fontSize) <= maxWidth;

  for (let word of words) {
    while (!fits(word) && word.length > 4) {
      // Hard-split a single over-long token so it can never overflow the box.
      let cut = word.length - 1;
      while (cut > 1 && !fits(word.slice(0, cut) + "-")) cut--;
      if (line) { lines.push(line); line = ""; }
      lines.push(word.slice(0, cut) + "-");
      word = word.slice(cut);
    }
    const candidate = line ? `${line} ${word}` : word;
    if (fits(candidate)) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);

  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (last.length > 1 && !fits(last + "…")) last = last.slice(0, -1).trimEnd();
    kept[maxLines - 1] = last + "…";
    return kept;
  }
  return lines.length ? lines : [""];
}

type LaidNode = {
  node: DiagramNodeT;
  colIdx: number;
  rowIdx: number;
  x: number;
  y: number;
  w: number;
  h: number;
  labelLines: string[];
  subLines: string[];
};

function roleFill(role: DiagramNodeT["role"]): { fill: string; stroke: string; text: string; sub: string; dash: string } {
  switch (role) {
    case "input": return { fill: CREAM, stroke: INK, text: TEXT, sub: MUTE, dash: "" };
    case "process": return { fill: AMBER, stroke: INK, text: INK, sub: "#5A4A12", dash: "" };
    case "output": return { fill: INK, stroke: INK, text: CREAM, sub: "rgba(244,238,222,0.75)", dash: "" };
    case "store": return { fill: PAPER, stroke: INK, text: TEXT, sub: MUTE, dash: "6 4" };
    case "note": return { fill: "none", stroke: "none", text: TEXT, sub: MUTE, dash: "" };
  }
}

/** Drop unknown/duplicate references so a slightly-off spec still renders. */
function sanitizeSpec(spec: DiagramSpecT): DiagramSpecT {
  const seen = new Set<string>();
  const nodes = spec.nodes.filter((n) => {
    if (seen.has(n.id)) return false;
    seen.add(n.id);
    return true;
  });
  const ids = new Set(nodes.map((n) => n.id));
  const edges = spec.edges.filter((e) => e.from !== e.to && ids.has(e.from) && ids.has(e.to));
  const groups = spec.groups
    .map((g) => ({ ...g, nodes: g.nodes.filter((id) => ids.has(id)) }))
    .filter((g) => g.nodes.length > 0);
  return { ...spec, nodes, edges, groups };
}

function bezierMid(p0: [number, number], p1: [number, number], p2: [number, number], p3: [number, number]): [number, number] {
  return [
    (p0[0] + 3 * p1[0] + 3 * p2[0] + p3[0]) / 8,
    (p0[1] + 3 * p1[1] + 3 * p2[1] + p3[1]) / 8,
  ];
}

function textBlock(lines: string[], x: number, y: number, opts: {
  size: number; family: string; fill: string; weight?: number; anchor?: string; lineHeight?: number; style?: string;
}): string {
  const lh = opts.lineHeight ?? opts.size * 1.25;
  return lines
    .map((ln, i) =>
      `<text x="${x}" y="${(y + i * lh).toFixed(1)}" font-family="${opts.family}" font-size="${opts.size}"` +
      `${opts.weight ? ` font-weight="${opts.weight}"` : ""}${opts.anchor ? ` text-anchor="${opts.anchor}"` : ""}` +
      `${opts.style ? ` ${opts.style}` : ""} fill="${opts.fill}">${esc(ln)}</text>`)
    .join("");
}

export function renderDiagram(rawSpec: DiagramSpecT, info: InfographicT): string {
  const spec = sanitizeSpec(rawSpec);
  if (spec.nodes.length < 2) throw new Error("diagram spec has fewer than 2 usable nodes");

  const { w: W, h: H } = CANVAS[info.layout];
  const innerW = W - 2 * MARGIN_X;
  const suffix = (info.id || "d").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "d";

  // --- Title + footnote furniture (heights known before grid layout) ---
  const titleLines = wrapText(info.title, innerW - 8, 21, 2);
  const titleH = 34 + titleLines.length * 26 + (spec.groups.length > 0 ? 14 : 4);
  const footLines = spec.footnote ? wrapText(spec.footnote, innerW - 8, 11, 2) : [];
  const footH = footLines.length ? footLines.length * 15 + 16 : 6;

  // --- Grid compaction ---
  const cols = [...new Set(spec.nodes.map((n) => n.col))].sort((a, b) => a - b);
  const rows = [...new Set(spec.nodes.map((n) => n.row))].sort((a, b) => a - b);
  const colIdx = new Map(cols.map((c, i) => [c, i]));
  const rowIdx = new Map(rows.map((r, i) => [r, i]));
  const nCols = cols.length;
  const nRows = rows.length;

  // Column gap grows to fit the widest horizontal edge label (labels sit in
  // the gap; scale-to-fit below absorbs the extra width if space runs out).
  const maxEdgeLabelW = Math.max(0, ...spec.edges.filter((e) => e.label).map((e) => estWidth(e.label, 11)));
  const gapX = Math.max(GAP_X, Math.min(132, maxEdgeLabelW + 18));

  // Narrow grids (1-2 columns) get wider boxes — a single 270-unit column
  // floating in a 700-unit canvas reads as a skinny strip of tiny text.
  const boxWMax = nCols <= 2 ? 420 : 270;
  const boxW = Math.max(120, Math.min(boxWMax, (innerW - (nCols - 1) * gapX) / nCols));

  // --- Measure every node ---
  const laid: LaidNode[] = spec.nodes.map((node) => {
    const pad = node.role === "note" ? 0 : 28;
    const labelLines = wrapText(node.label, boxW - pad, node.role === "note" ? NOTE_SIZE : LABEL_SIZE, node.role === "note" ? 6 : 3);
    const subLines = node.sublabel ? wrapText(node.sublabel, boxW - pad, SUB_SIZE, node.role === "note" ? 5 : 3) : [];
    const h = node.role === "note"
      ? labelLines.length * 16 + subLines.length * 14 + 8
      : Math.max(54, 15 + labelLines.length * 21 + (subLines.length ? 5 + subLines.length * 15 : 0) + 15);
    return { node, colIdx: colIdx.get(node.col) ?? 0, rowIdx: rowIdx.get(node.row) ?? 0, x: 0, y: 0, w: boxW, h, labelLines, subLines };
  });

  // --- Row heights + natural grid size ---
  const rowH: number[] = Array.from({ length: nRows }, (_, r) =>
    Math.max(54, ...laid.filter((n) => n.rowIdx === r).map((n) => n.h)),
  );
  const gapY = nRows > 1 ? 46 : 0;
  const naturalW = nCols * boxW + (nCols - 1) * gapX;
  const naturalH = rowH.reduce((a, b) => a + b, 0) + (nRows - 1) * gapY;

  // --- Place nodes on the natural grid ---
  const rowY: number[] = [];
  let acc = 0;
  for (let r = 0; r < nRows; r++) { rowY.push(acc); acc += rowH[r] + gapY; }
  for (const n of laid) {
    n.x = n.colIdx * (boxW + gapX);
    n.y = rowY[n.rowIdx] + (rowH[n.rowIdx] - n.h) / 2;
  }

  // --- Scale-to-fit BOTH ways: the grid can never overflow the canvas, and a
  // small grid is scaled UP (capped) so it fills the card instead of floating
  // as a tiny island with huge margins. Type scales with it.
  const availH = H - titleH - footH - MARGIN_Y - 14;
  const scale = Math.min(1.75, innerW / naturalW, availH / naturalH);
  const tx = MARGIN_X + (innerW - naturalW * scale) / 2;
  const ty = titleH + 14 + Math.max(0, (availH - naturalH * scale) / 2);

  const parts: string[] = [];

  // Background card — keeps the diagram readable on dark pages.
  parts.push(`<rect x="1.5" y="1.5" width="${W - 3}" height="${H - 3}" rx="14" fill="${PAPER}" stroke="rgba(11,16,39,0.18)" stroke-width="1.5"/>`);

  // Title furniture.
  parts.push(`<rect x="${MARGIN_X}" y="${MARGIN_Y - 6}" width="30" height="4" fill="${AMBER}"/>`);
  parts.push(textBlock(titleLines, MARGIN_X, MARGIN_Y + 20, { size: 21, family: FRAUNCES, fill: INK, weight: 600 }));

  // Defs: arrowhead marker (id namespaced per diagram — multiple inline SVGs share one DOM).
  parts.push(`<defs><marker id="ah-${suffix}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" fill="${TEXT}"/></marker></defs>`);

  const grid: string[] = [];

  // Groups first (behind nodes).
  for (const g of spec.groups) {
    const members = laid.filter((n) => g.nodes.includes(n.node.id));
    if (!members.length) continue;
    const bx = Math.min(...members.map((n) => n.x)) - 13;
    const by = Math.min(...members.map((n) => n.y)) - 13;
    const bx2 = Math.max(...members.map((n) => n.x + n.w)) + 13;
    const by2 = Math.max(...members.map((n) => n.y + n.h)) + 13;
    grid.push(`<rect x="${bx}" y="${by}" width="${bx2 - bx}" height="${by2 - by}" rx="12" fill="${AMBER}" fill-opacity="0.09"/>`);
    grid.push(`<text x="${bx + 2}" y="${by - 7}" font-family="${GEIST}" font-size="10" letter-spacing="2" fill="${MUTE}">${esc(g.label.toUpperCase())}</text>`);
  }

  // Edges (lines under boxes; labels collected for a top layer so a box can
  // never cover them).
  const byId = new Map(laid.map((n) => [n.node.id, n]));
  const edgeLabels: string[] = [];
  for (const e of spec.edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue;
    const drawn = renderEdge(e, a, b, suffix);
    grid.push(drawn.line);
    if (drawn.label) edgeLabels.push(drawn.label);
  }

  // Nodes.
  for (const n of laid) {
    const style = roleFill(n.node.role);
    if (n.node.role === "note") {
      grid.push(`<rect x="${n.x}" y="${n.y + 3}" width="6" height="6" fill="${AMBER_DEEP}"/>`);
      grid.push(textBlock(n.labelLines, n.x + 14, n.y + 10, { size: NOTE_SIZE, family: GEIST, fill: style.text, lineHeight: 16 }));
      if (n.subLines.length) {
        grid.push(textBlock(n.subLines, n.x + 14, n.y + 10 + n.labelLines.length * 16 + 2, { size: SUB_SIZE - 0.5, family: GEIST, fill: style.sub, lineHeight: 14 }));
      }
      continue;
    }
    grid.push(`<rect x="${n.x}" y="${n.y.toFixed(1)}" width="${n.w}" height="${n.h}" rx="8" ry="8" fill="${style.fill}" stroke="${style.stroke}" stroke-width="2"${style.dash ? ` stroke-dasharray="${style.dash}"` : ""}/>`);
    const cx = n.x + n.w / 2;
    const blockH = n.labelLines.length * 21 + (n.subLines.length ? 5 + n.subLines.length * 15 : 0);
    const startY = n.y + (n.h - blockH) / 2 + 15;
    grid.push(textBlock(n.labelLines, cx, startY, { size: LABEL_SIZE, family: FRAUNCES, fill: style.text, weight: 600, anchor: "middle", lineHeight: 21 }));
    if (n.subLines.length) {
      grid.push(textBlock(n.subLines, cx, startY + n.labelLines.length * 21 - 16 + 5 + 15, { size: SUB_SIZE, family: GEIST, fill: style.sub, anchor: "middle", lineHeight: 15 }));
    }
  }

  grid.push(...edgeLabels);
  parts.push(`<g transform="translate(${tx.toFixed(1)},${ty.toFixed(1)}) scale(${scale.toFixed(4)})">${grid.join("")}</g>`);

  // Footnote.
  if (footLines.length) {
    parts.push(`<rect x="${MARGIN_X}" y="${H - footH - 10}" width="22" height="3" fill="${AMBER}"/>`);
    parts.push(textBlock(footLines, MARGIN_X, H - footH + 4, { size: 11, family: GEIST, fill: MUTE, lineHeight: 15 }));
  }

  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(info.title)}">${parts.join("")}</svg>`;
}

function renderEdge(e: DiagramEdgeT, a: LaidNode, b: LaidNode, suffix: string): { line: string; label: string } {
  const dCol = b.colIdx - a.colIdx;
  const dRow = b.rowIdx - a.rowIdx;
  let p0: [number, number], p3: [number, number], p1: [number, number], p2: [number, number];

  if (dCol > 0) {
    // Forward (left → right).
    p0 = [a.x + a.w, a.y + a.h / 2];
    p3 = [b.x, b.y + b.h / 2];
    const bend = Math.max(24, (p3[0] - p0[0]) * 0.45);
    p1 = [p0[0] + bend, p0[1]];
    p2 = [p3[0] - bend, p3[1]];
  } else if (dCol === 0 && dRow !== 0) {
    // Vertical within a column.
    const down = dRow > 0;
    p0 = [a.x + a.w / 2, down ? a.y + a.h : a.y];
    p3 = [b.x + b.w / 2, down ? b.y : b.y + b.h];
    const bend = Math.max(20, Math.abs(p3[1] - p0[1]) * 0.45) * (down ? 1 : -1);
    p1 = [p0[0], p0[1] + bend];
    p2 = [p3[0], p3[1] - bend];
  } else {
    // Feedback / backward — loop under both boxes.
    p0 = [a.x + a.w / 2, a.y + a.h];
    p3 = [b.x + b.w / 2, b.y + b.h];
    const dip = Math.max(a.y + a.h, b.y + b.h) + 42;
    p1 = [p0[0], dip];
    p2 = [p3[0], dip];
  }

  const isNoteLink = a.node.role === "note" || b.node.role === "note";
  const dashed = e.style === "dashed" || isNoteLink;
  const stroke = isNoteLink ? MUTE : TEXT;
  const marker = isNoteLink ? "" : ` marker-end="url(#ah-${suffix})"`;
  const d = `M${p0[0].toFixed(1)},${p0[1].toFixed(1)} C${p1[0].toFixed(1)},${p1[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)} ${p3[0].toFixed(1)},${p3[1].toFixed(1)}`;
  const line = `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.6"${dashed ? ' stroke-dasharray="5 4"' : ""}${marker}/>`;

  let label = "";
  if (e.label) {
    const [mx, my] = bezierMid(p0, p1, p2, p3);
    const lift = dCol > 0 ? -9 : dCol === 0 && dRow !== 0 ? 4 : -7;
    const text = wrapText(e.label, 150, 11, 1)[0];
    label = `<text x="${mx.toFixed(1)}" y="${(my + lift).toFixed(1)}" font-family="${GEIST}" font-size="11" text-anchor="middle" fill="${TEXT}" paint-order="stroke" stroke="${PAPER}" stroke-width="5" stroke-linejoin="round">${esc(text)}</text>`;
  }
  return { line, label };
}

/**
 * Deterministic fallback when spec generation fails entirely — a typeset
 * "field note" card with the diagram's title + concept. Pure function, cannot
 * fail, so the PDF never ships a dashed placeholder box.
 */
export function fallbackDiagram(info: InfographicT): string {
  const { w: W, h: H } = CANVAS[info.layout];
  const textW = Math.min(W - 2 * MARGIN_X - 24, 700);
  const titleLines = wrapText(info.title, textW, 30, 3);
  const conceptLines = wrapText(info.concept, textW - 30, 16, 9);

  // Vertically center the whole composition so the card never reads as an
  // accidentally-empty canvas.
  const titleBlockH = titleLines.length * 37;
  const conceptBlockH = conceptLines.length * 23;
  const motifH = 56;
  const totalH = 16 + 14 + 12 + titleBlockH + 20 + conceptBlockH + 34 + motifH;
  const top = Math.max(MARGIN_Y, (H - totalH) / 2);
  const left = (W - textW) / 2;

  const parts: string[] = [];
  parts.push(`<rect x="1.5" y="1.5" width="${W - 3}" height="${H - 3}" rx="14" fill="${PAPER}" stroke="rgba(11,16,39,0.18)" stroke-width="1.5"/>`);
  parts.push(`<text x="${left}" y="${top + 10}" font-family="${GEIST}" font-size="11" letter-spacing="3" fill="${MUTE}">FIELD NOTE</text>`);
  parts.push(`<rect x="${left}" y="${top + 22}" width="34" height="4" fill="${AMBER}"/>`);
  const titleY = top + 22 + 12 + 30;
  parts.push(textBlock(titleLines, left, titleY, { size: 30, family: FRAUNCES, fill: INK, weight: 600, lineHeight: 37 }));
  const conceptY = titleY + (titleLines.length - 1) * 37 + 20 + 16;
  parts.push(`<rect x="${left}" y="${conceptY - 15}" width="3" height="${conceptBlockH + 4}" fill="${AMBER}"/>`);
  parts.push(textBlock(conceptLines, left + 18, conceptY, { size: 16, family: GEIST, fill: TEXT, lineHeight: 23 }));

  // Abstract three-stage motif — signals "flow" even without a full diagram.
  const my = conceptY + conceptBlockH + 34;
  const bw = 84, bh = 34, gap = 56;
  const mx = left;
  for (let i = 0; i < 3; i++) {
    const x = mx + i * (bw + gap);
    const fill = i === 1 ? AMBER : i === 2 ? INK : CREAM;
    parts.push(`<rect x="${x}" y="${my}" width="${bw}" height="${bh}" rx="7" fill="${fill}" fill-opacity="${i === 0 ? 1 : 0.92}" stroke="${INK}" stroke-width="1.6"/>`);
    if (i < 2) {
      parts.push(`<path d="M${x + bw + 6},${my + bh / 2} L${x + bw + gap - 8},${my + bh / 2}" stroke="${TEXT}" stroke-width="1.6" marker-end="url(#ah-fb-${(info.id || "d").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 16)})"/>`);
    }
  }
  parts.unshift(`<defs><marker id="ah-fb-${(info.id || "d").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 16)}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" fill="${TEXT}"/></marker></defs>`);
  parts.push(`<text x="${W - MARGIN_X}" y="${H - 24}" font-family="${GEIST}" font-size="10" letter-spacing="2" text-anchor="end" fill="${MUTE}">FIELD GUIDE</text>`);
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(info.title)}">${parts.join("")}</svg>`;
}
