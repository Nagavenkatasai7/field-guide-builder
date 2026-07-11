/**
 * Author identity — the single place this template reads "who is publishing".
 *
 * Every value comes from an environment variable with a generic placeholder
 * default, so the repo runs out-of-the-box as a template and a new user makes
 * it theirs by setting these in `.env.local` (see `.env.local.example`). No
 * personal identity is hardcoded anywhere else — the prompts, PDF templates,
 * and captions all interpolate `AUTHOR.*`.
 *
 * Fields:
 *   name     — the byline / real name the post publishes under.
 *   brand    — channel or series name (e.g. a YouTube/newsletter brand).
 *   hashtag  — signature hashtag; MUST start with '#'.
 *   youtube  — channel URL/handle; empty string omits it cleanly.
 *   role     — one-line professional descriptor (reads after "is …").
 *   bio      — short author bio for the PDF colophon.
 *   audience — who the content is written for.
 *   email    — alert recipient; mirrors ALERT_EMAIL_TO ('' = alerts disabled).
 */
export const AUTHOR = {
  name:     process.env.AUTHOR_NAME     || "Your Name",
  brand:    process.env.AUTHOR_BRAND    || "Your Brand",         // channel/series name
  hashtag:  process.env.AUTHOR_HASHTAG  || "#YourHashtag",       // must start with '#'
  youtube:  process.env.AUTHOR_YOUTUBE  || "",                   // e.g. youtube.com/@handle ('' = omit)
  role:     process.env.AUTHOR_ROLE     || "a builder who turns complex topics into clear guides",
  bio:      process.env.AUTHOR_BIO      || "<short author bio — who you are and what you write about>",
  audience: process.env.AUTHOR_AUDIENCE || "curious professionals and builders",
  email:    process.env.ALERT_EMAIL_TO  || "",
};
