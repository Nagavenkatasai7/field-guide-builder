// Run with: node --env-file=.env.local scripts/ping-llm.mjs [model]
// Verifies Ollama Cloud auth + reachability for the configured models.

import { Ollama } from "ollama";

const apiKey = process.env.OLLAMA_API_KEY || process.env.Ollama_API_KEY;
if (!apiKey) {
  console.error("✗ OLLAMA_API_KEY is not set in .env.local");
  process.exit(2);
}

const model = process.argv[2] || process.env.LLM_PRIMARY_MODEL || "gemma4:31b-cloud";
const fallback = process.env.LLM_FALLBACK_MODEL || "kimi-k2.6:cloud";
const targets = process.argv[2] ? [model] : [model, fallback];

const client = new Ollama({
  host: process.env.OLLAMA_HOST || "https://ollama.com",
  headers: { Authorization: `Bearer ${apiKey}` },
});

let failures = 0;
for (const m of targets) {
  process.stdout.write(`→ ${m}: `);
  const start = Date.now();
  try {
    const res = await client.chat({
      model: m,
      stream: false,
      messages: [
        { role: "system", content: "Reply with exactly one word: pong" },
        { role: "user", content: "ping" },
      ],
      options: { temperature: 0, num_predict: 32 },
    });
    const text = (res.message.content || "").trim().replace(/\s+/g, " ");
    console.log(
      `"${text}" — ${res.prompt_eval_count ?? "?"} in / ${res.eval_count ?? "?"} out tokens in ${Date.now() - start}ms`,
    );
  } catch (err) {
    failures++;
    console.log(`FAILED (${err instanceof Error ? err.message : String(err)})`);
  }
}

process.exit(failures > 0 ? 1 : 0);
