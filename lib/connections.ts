/**
 * Connection pipeline (M16): drafts personalized LinkedIn connection notes
 * for target companies the owner supplies, referencing the latest published
 * guide as the shared-interest hook.
 *
 * Same HARD BOUNDARY as the engagement cockpit: PREPARE-only. Nothing here
 * touches the LinkedIn API; the owner sends every request by hand.
 */

import { z } from "zod";
import { chat } from "@/lib/llm";
import { AUTHOR } from "@/lib/identity";

export type CompanyInput = { company: string; roleHint: string | null };
export type DraftedNote = { company: string; role_hint: string | null; note: string };

// LinkedIn caps connection notes at 300 chars — leave editing headroom.
export const NOTE_MAX_CHARS = 280;
const LLM_TIMEOUT_MS = 60_000;

const NotesSchema = z.object({
  items: z.array(z.object({ company: z.string(), note: z.string().min(60) })).min(1),
});

function extractJson(text: string): string {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  return first >= 0 && last > first ? text.slice(first, last + 1) : text;
}

function cleanNote(raw: string): string {
  return raw
    .replace(/\bhttps?:\/\/\S+/gi, "")
    .replace(/\bwww\.\S+/gi, "")
    .replace(/#\w+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NOTE_MAX_CHARS);
}

const NOTES_SYSTEM_PROMPT = `You draft LinkedIn connection-request notes for ${AUTHOR.name} — ${AUTHOR.role}. ${AUTHOR.name} sends each request BY HAND after editing.

Rules for every note:
- Max ${NOTE_MAX_CHARS} characters. One or two sentences. Plain text: no links, hashtags, emojis, or placeholders like [Name] — open with the substance, not a greeting, so the note works for any recipient at that company.
- Anchor on a plausible shared professional interest between ${AUTHOR.name}'s work (AI workflow automation — see the latest guide topic provided) and what someone in the given role at that company works on. Be specific to the company/role, never generic ("I'd love to connect and grow my network" is banned).
- Never ask for a job, a referral, or a favor. Never flatter ("huge fan"). The note offers a point of common ground and that's all.
- Never invent facts about the company. If you only know the name, anchor on the role + the guide topic instead.
- Voice: warm, direct, zero hype.

Output ONLY a JSON object (no markdown fences): {"items":[{"company": string (copied verbatim), "note": string}, ...]} — one entry per input company, same order.`;

export async function draftConnectionNotes(
  companies: CompanyInput[],
  latestGuide: { title: string | null; topic: string | null } | null,
): Promise<DraftedNote[]> {
  const guideLine = latestGuide?.topic || latestGuide?.title
    ? `Latest published guide: "${latestGuide.title ?? latestGuide.topic}" (topic: ${latestGuide.topic ?? "n/a"})`
    : "No guide published yet — anchor on the role and AI workflow automation generally.";
  const user = `${guideLine}\n\nCompanies:\n${companies
    .map((c, i) => `${i + 1}. ${c.company}${c.roleHint ? ` — target role: ${c.roleHint}` : ""}`)
    .join("\n")}`;

  const r = await chat({
    stage: "connections",
    system: NOTES_SYSTEM_PROMPT,
    user,
    json: "json",
    think: false,
    temperature: 0.7,
    maxTokens: 1800,
    timeoutMs: LLM_TIMEOUT_MS,
  });
  const parsed = NotesSchema.safeParse(JSON.parse(extractJson(r.text)));
  if (!parsed.success) throw new Error("note drafting returned an unusable shape — try again");

  const byCompany = new Map(parsed.data.items.map((i) => [i.company.toLowerCase().trim(), i.note]));
  const out: DraftedNote[] = [];
  for (const c of companies) {
    const note = cleanNote(byCompany.get(c.company.toLowerCase().trim()) ?? "");
    if (note.length < 60) continue; // dropped rather than shipping filler
    out.push({ company: c.company, role_hint: c.roleHint, note });
  }
  if (out.length === 0) throw new Error("note drafting produced no usable notes — try again");
  return out;
}
