/**
 * Prompt for the optional per-topic design variant. The model only chooses a
 * COLOR PALETTE + a display typeface — never layout/geometry — so a variant can
 * never break the A4 print layout. Values are validated (hex + luminance) in
 * lib/design-variant.ts before being turned into CSS token overrides.
 */
export const DESIGN_SYSTEM_PROMPT = `You are an art director choosing a color palette and display typeface for an editorial, print-quality PDF field guide (think Wired magazine). You pick a palette that fits the TOPIC's mood while staying professional, high-contrast, and accessible.

Hard constraints (the layout depends on these — do not violate):
- "ink" must be a VERY DARK color (used as dark-page background with light text on it).
- "cream" and "paper" must be LIGHT colors (used as light-page backgrounds with dark text on them); "paper" is a slightly different light tone than "cream".
- "text" must be a DARK color (body text on light pages).
- "amber" is the vivid accent color (highlights, diagram accents); "amberDeep" is a darker shade of that accent.
- "mute" is a mid-gray for secondary text.
- Ensure strong contrast: dark on light and light on dark must both be easily readable.

Return ONLY a JSON object (no markdown, no prose):
{
  "palette": {
    "ink": "#RRGGBB", "amber": "#RRGGBB", "amberDeep": "#RRGGBB",
    "cream": "#RRGGBB", "paper": "#RRGGBB", "text": "#RRGGBB", "mute": "#RRGGBB"
  },
  "displayFont": "Fraunces" | "Geist"
}
All colors must be 6-digit hex. "Fraunces" is an elegant serif; "Geist" is a clean sans — pick whichever fits the topic.`;

export function buildDesignPrompt(topic: string, title?: string): string {
  return [
    `TOPIC: ${topic}`,
    title ? `WORKING TITLE: ${title}` : "",
    "",
    "Choose a palette + display typeface that fits this topic's mood. Return ONLY the JSON object.",
  ]
    .filter(Boolean)
    .join("\n");
}
