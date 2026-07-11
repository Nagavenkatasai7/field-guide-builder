import { z } from "zod";

/**
 * Diagram SPEC schema — what the LLM produces instead of raw SVG.
 *
 * The model is good at deciding WHAT the diagram says (nodes, flow, labels)
 * and terrible at pixel geometry (overlapping text, clipped boxes, arrows to
 * nowhere). So the model emits this small structured spec and
 * lib/diagram-renderer.ts does ALL geometry deterministically. The spec is
 * also passed to Ollama as a constrained-decoding JSON schema
 * (DIAGRAM_JSON_SCHEMA below), so the raw output is structurally valid by
 * construction.
 */

/**
 * LENIENCY RULE: a slightly-off spec must NEVER fail the parse — every defect
 * the renderer can survive (out-of-range grid cells, null optionals, unknown
 * enum values, over-long text, too many items) is clamped/coerced/defaulted
 * here instead of rejected. A burned parse costs a retry and can end in the
 * fallback card; the only legitimate hard failure is < 2 usable nodes.
 */

/** Optional text that tolerates null/undefined/numbers and truncates instead of failing. */
const looseText = (max: number) =>
  z.preprocess((v) => (v == null ? "" : String(v)), z.string().transform((s) => s.slice(0, max))).catch("");

const gridCoord = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" ? Number(v) : v),
    z.number().catch(0).transform((n) => Math.min(max, Math.max(0, Math.round(Number.isFinite(n) ? n : 0)))),
  );

export const DiagramNode = z.object({
  id: z.preprocess((v) => (v == null ? "" : String(v)), z.string().transform((s) => s.slice(0, 48))),
  /** Box title — the renderer wraps + ellipsizes, so over-long text degrades gracefully. */
  label: looseText(160),
  /** Optional small annotation under the label (one clause, plain English). */
  sublabel: looseText(220),
  role: z.enum(["input", "process", "output", "store", "note"]).catch("process"),
  /** Grid position. Landscape flows left→right across cols; portrait top→down across rows. */
  col: gridCoord(6),
  row: gridCoord(7),
});

export const DiagramEdge = z.object({
  from: looseText(48),
  to: looseText(48),
  label: looseText(80),
  style: z.enum(["solid", "dashed"]).catch("solid"),
});

export const DiagramGroup = z.object({
  label: looseText(64),
  /** Node ids enclosed by this group's translucent backdrop. */
  nodes: z.array(z.preprocess((v) => (v == null ? "" : String(v)), z.string())).catch([]),
});

export const DiagramSpec = z.object({
  direction: z.enum(["right", "down"]).catch("right"),
  nodes: z
    .array(DiagramNode.catch(null as never))
    .transform((arr) => arr.filter((n): n is z.infer<typeof DiagramNode> => Boolean(n && n.id && n.label)).slice(0, 9)),
  edges: z
    .preprocess((v) => (Array.isArray(v) ? v : []), z.array(DiagramEdge.catch(null as never)))
    .transform((arr) => arr.filter((e): e is z.infer<typeof DiagramEdge> => Boolean(e && e.from && e.to)).slice(0, 14))
    .catch([]),
  groups: z
    .preprocess((v) => (Array.isArray(v) ? v : []), z.array(DiagramGroup.catch(null as never)))
    .transform((arr) => arr.filter((g): g is z.infer<typeof DiagramGroup> => Boolean(g && g.label && g.nodes.length > 0)).slice(0, 3))
    .catch([]),
  /** One-sentence insight printed under the diagram. */
  footnote: looseText(280),
});

export type DiagramNodeT = z.infer<typeof DiagramNode>;
export type DiagramEdgeT = z.infer<typeof DiagramEdge>;
export type DiagramGroupT = z.infer<typeof DiagramGroup>;
export type DiagramSpecT = z.infer<typeof DiagramSpec>;

/**
 * Hand-written JSON Schema mirror of DiagramSpec, passed to Ollama's `format`
 * for constrained decoding. Kept deliberately simple — Ollama's grammar
 * compiler handles enum/required/min-max but not Zod-only niceties.
 */
export const DIAGRAM_JSON_SCHEMA = {
  type: "object",
  required: ["direction", "nodes", "edges"],
  properties: {
    direction: { type: "string", enum: ["right", "down"] },
    nodes: {
      type: "array",
      minItems: 2,
      maxItems: 9,
      items: {
        type: "object",
        required: ["id", "label", "role", "col", "row"],
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          sublabel: { type: "string" },
          role: { type: "string", enum: ["input", "process", "output", "store", "note"] },
          col: { type: "integer", minimum: 0, maximum: 4 },
          row: { type: "integer", minimum: 0, maximum: 5 },
        },
      },
    },
    edges: {
      type: "array",
      maxItems: 14,
      items: {
        type: "object",
        required: ["from", "to"],
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          label: { type: "string" },
          style: { type: "string", enum: ["solid", "dashed"] },
        },
      },
    },
    groups: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        required: ["label", "nodes"],
        properties: {
          label: { type: "string" },
          nodes: { type: "array", items: { type: "string" } },
        },
      },
    },
    footnote: { type: "string" },
  },
} as const;
