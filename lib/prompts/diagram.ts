import type { InfographicT, PlanT } from "@/lib/plan-schema";

/**
 * Diagram SPEC prompt — replaces the old free-form SVG prompt.
 *
 * The model never draws: it returns a JSON spec (nodes/edges/groups on a small
 * grid) and lib/diagram-renderer.ts typesets it deterministically. Output is
 * additionally constrained by DIAGRAM_JSON_SCHEMA at decode time.
 */

export const DIAGRAM_SYSTEM_PROMPT = `You are a senior information designer for Field Guide magazine, in the tradition of Jay Alammar's "Illustrated Transformer". You design ONE explanatory diagram per request — but you do NOT draw it. You return a JSON spec; a deterministic typesetter lays it out pixel-perfectly.

Your entire skill is choosing the RIGHT boxes, the RIGHT flow, and the RIGHT few words.

DESIGN RULES (non-negotiable):
- 3 to 7 nodes. Fewer, clearer boxes beat many cluttered ones.
- Each node label: 2-5 words, Title Case, the NAME of the thing (e.g. "Token Embeddings", "Vector Index"). Never a sentence.
- Each sublabel: ONE short plain-English clause saying what the thing does (e.g. "turns words into numbers"). Max ~10 words. Most nodes should have one — this is where the teaching happens.
- Roles: "input" = what enters the system; "process" = transformation steps (the visual focus); "output" = what comes out; "store" = data at rest (DB, cache, index); "note" = ONE optional unboxed annotation for the key insight or gotcha.
- The flow must be OBVIOUS and read in one direction. Edges connect consecutive stages; add at most one labeled feedback/retry edge if the mechanism truly has one.
- Edge labels: 1-3 words naming what travels along the arrow (e.g. "embeddings", "top-k docs"). Only label an edge when the payload isn't obvious.
- Use a group when 2-3 nodes form one conceptual unit (e.g. "Retrieval stage"). Max 2 groups.
- footnote: one concrete sentence with the single most useful insight a reader should retain — a number, a tradeoff, or "the part most people miss". Not a summary.

GRID (how position works):
- The canvas is a small grid. "col" is the horizontal slot (0 = leftmost), "row" is the vertical slot (0 = topmost).
- LANDSCAPE diagrams flow left-to-right: put successive stages in cols 0,1,2,3 (max col 3). Use rows 0-2 only to stack parallel branches; keep the main path on one row.
- PORTRAIT diagrams flow top-to-bottom: put successive stages in rows 0,1,2,3,4 (max row 4). Use cols 0-1 only for parallel branches; keep the main path in one column.
- Never place two nodes in the same (col,row) cell.
- Place a "note" node in an empty cell adjacent to what it annotates.

Return ONLY the JSON object. No markdown fences, no commentary.`;

export const DIAGRAM_STRICTER_SUFFIX = `

IMPORTANT: Your previous output failed validation. Return ONLY a raw JSON object with keys: direction ("right" or "down"), nodes (array of {id, label, sublabel, role, col, row}), edges (array of {from, to, label, style}), groups (optional), footnote (optional). Every edge's "from"/"to" must exactly match a node "id". No two nodes may share the same col AND row. 3-7 nodes.`;

export function buildDiagramUserPrompt(input: { plan: PlanT; infographic: InfographicT }): string {
  const { plan, infographic } = input;
  const related = plan.sections.find((s) => s.infographicId === infographic.id);
  return [
    `TOPIC OF THE GUIDE: ${plan.title}`,
    plan.subtitle ? `SUBTITLE: ${plan.subtitle}` : "",
    `AUDIENCE: ${plan.audience}`,
    "",
    `DIAGRAM TITLE: ${infographic.title}`,
    `LAYOUT: ${infographic.layout} — ${infographic.layout === "landscape" ? 'flows left-to-right, direction "right", cols 0-3' : 'flows top-to-bottom, direction "down", rows 0-4'}`,
    `WHAT THIS DIAGRAM MUST EXPLAIN: ${infographic.concept}`,
    related ? `SECTION IT ILLUSTRATES: ${related.title} — ${related.brief}` : "",
    "",
    "Design the diagram spec now. Choose the 3-7 nodes that best teach this mechanism, name what flows along each arrow, and put the one insight worth remembering in the footnote. Return ONLY the JSON object.",
  ].filter(Boolean).join("\n");
}
