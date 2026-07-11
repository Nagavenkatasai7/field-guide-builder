/**
 * Dev sanity check for the deterministic diagram renderer.
 * Run: npx tsx scripts/diagram-test.ts
 * Writes /tmp/diagram-test.svg + /tmp/diagram-fallback.svg for visual review
 * (e.g. screenshot with headless Chrome).
 */
import { writeFileSync } from "node:fs";
import { renderDiagram, fallbackDiagram } from "../lib/diagram-renderer";
import { DiagramSpec } from "../lib/diagram-schema";

const spec = DiagramSpec.parse({
  direction: "right",
  nodes: [
    { id: "query", label: "User Query", sublabel: "a question in plain English", role: "input", col: 0, row: 1 },
    { id: "embed", label: "Embedding Model", sublabel: "turns words into numbers", role: "process", col: 1, row: 1 },
    { id: "index", label: "Vector Index", sublabel: "millions of pre-embedded chunks", role: "store", col: 2, row: 0 },
    { id: "retrieve", label: "Similarity Search", sublabel: "finds the closest chunks", role: "process", col: 2, row: 1 },
    { id: "llm", label: "LLM with Context", sublabel: "answers using retrieved facts", role: "process", col: 3, row: 1 },
    { id: "answer", label: "Grounded Answer", role: "output", col: 4, row: 1 },
    { id: "tip", label: "Retrieval quality caps answer quality.", role: "note", col: 4, row: 0 },
  ],
  edges: [
    { from: "query", to: "embed", label: "text" },
    { from: "embed", to: "retrieve", label: "query vector" },
    { from: "index", to: "retrieve", label: "candidates", style: "dashed" },
    { from: "retrieve", to: "llm", label: "top-k chunks" },
    { from: "llm", to: "answer" },
  ],
  groups: [{ label: "Retrieval stage", nodes: ["index", "retrieve"] }],
  footnote: "The LLM never searches anything — retrieval happens before the model sees a single token.",
});

const info = { id: "rag-flow", title: "How RAG Turns a Question into a Grounded Answer", concept: "x".repeat(20), layout: "landscape" as const };
const svg = renderDiagram(spec, info);
if (/NaN|undefined|Infinity/.test(svg)) { console.error("BAD TOKENS IN SVG"); process.exit(1); }
writeFileSync("/tmp/diagram-test.svg", svg);

const fb = fallbackDiagram({ ...info, layout: "portrait", concept: "Left-to-right flow showing how a search query becomes a ranked result list via three labeled stages: parse, retrieve, rerank — and why the rerank stage is where quality is won or lost." });
if (/NaN|undefined|Infinity/.test(fb)) { console.error("BAD TOKENS IN FALLBACK"); process.exit(1); }
writeFileSync("/tmp/diagram-fallback.svg", fb);

console.log("ok — svg bytes:", svg.length, "fallback bytes:", fb.length);
