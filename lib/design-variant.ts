/**
 * Optional per-topic design variant. The LLM picks a palette + display font;
 * we validate (hex + luminance) and turn it into a small set of CSS custom-
 * property overrides layered on top of the FIXED structural print CSS. This
 * gives a genuinely different look per topic for A/B-ing, while guaranteeing
 * the A4 layout can never break (no geometry/structure is model-controlled).
 *
 * Daily automation uses the consistent DEFAULT design (no theme). This is an
 * opt-in for the manual flow.
 */

import { z } from "zod";
import { chat } from "@/lib/llm";
import { DESIGN_SYSTEM_PROMPT, buildDesignPrompt } from "@/lib/prompts/design";

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const DesignTheme = z.object({
  palette: z.object({
    ink: hex,
    amber: hex,
    amberDeep: hex,
    cream: hex,
    paper: hex,
    text: hex,
    mute: hex,
  }),
  displayFont: z.enum(["Fraunces", "Geist"]),
});
export type DesignThemeT = z.infer<typeof DesignTheme>;

/** Relative luminance (0=black, 1=white) for a #RRGGBB string. */
function luminance(hexColor: string): number {
  const r = parseInt(hexColor.slice(1, 3), 16) / 255;
  const g = parseInt(hexColor.slice(3, 5), 16) / 255;
  const b = parseInt(hexColor.slice(5, 7), 16) / 255;
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Reject palettes that would be unreadable (dark text on dark page, etc.). */
function isReadable(t: DesignThemeT): boolean {
  const p = t.palette;
  return (
    luminance(p.ink) < 0.3 && // dark pages are dark
    luminance(p.text) < 0.4 && // body text is dark
    luminance(p.cream) > 0.6 && // light pages are light
    luminance(p.paper) > 0.6
  );
}

/** Pure builder — all inputs validated, so the output CSS is injection-safe. */
export function buildThemeCss(t: DesignThemeT): string {
  const p = t.palette;
  const fallback = t.displayFont === "Fraunces" ? "Georgia, serif" : "ui-sans-serif, system-ui, sans-serif";
  return [
    ":root{",
    `--ink:${p.ink};--amber:${p.amber};--amber-deep:${p.amberDeep};`,
    `--cream:${p.cream};--paper:${p.paper};--text:${p.text};--mute:${p.mute};`,
    `--hairline:${p.ink}2e;--hairline-on-dark:${p.cream}40;`,
    "}",
    `.display{font-family:'${t.displayFont}', ${fallback};}`,
  ].join("");
}

/**
 * Generate a validated theme for a topic. Returns the theme on success, or
 * null if generation/validation fails (caller falls back to the default
 * design — a variant is never worth a broken or unreadable PDF).
 */
export async function generateDesignTheme(topic: string, title?: string): Promise<DesignThemeT | null> {
  try {
    const result = await chat({
      stage: "design",
      system: DESIGN_SYSTEM_PROMPT,
      user: buildDesignPrompt(topic, title),
      json: "json",
      think: false,
      temperature: 0.8,
      maxTokens: 400,
      timeoutMs: 30_000,
    });
    const first = result.text.indexOf("{");
    const last = result.text.lastIndexOf("}");
    const raw = first >= 0 && last > first ? result.text.slice(first, last + 1) : result.text;
    const theme = DesignTheme.parse(JSON.parse(raw));
    if (!isReadable(theme)) {
      console.warn("[design-variant] palette failed readability check — falling back to default");
      return null;
    }
    return theme;
  } catch (err) {
    console.warn(`[design-variant] generation failed — using default design: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
