import { z } from "zod";

export const SECTION_KINDS = [
  "cover",
  "toc",
  "definition",
  "problem",
  "body",
  "comparison",
  "step-by-step",
  "use-cases",
  "why-it-matters",
  "recap",
  "colophon",
] as const;

export const Infographic = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(120),
  concept: z.string().min(10).max(400),
  layout: z.enum(["landscape", "portrait"]),
});

export const Section = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(SECTION_KINDS),
  title: z.string().min(1).max(160),
  background: z.enum(["dark", "cream"]),
  brief: z.string().min(10).max(600),
  infographicId: z.string().max(64).optional().nullable(),
});

export const Plan = z.object({
  title: z.string().min(2).max(160),
  subtitle: z.string().max(200).optional().default(""),
  audience: z.string().min(5).max(300),
  sections: z.array(Section).min(8).max(15),
  infographics: z.array(Infographic).min(2).max(4),
});

export type PlanT = z.infer<typeof Plan>;
export type SectionT = z.infer<typeof Section>;
export type InfographicT = z.infer<typeof Infographic>;
