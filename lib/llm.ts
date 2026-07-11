import { Ollama, type ChatRequest } from "ollama";

const DEFAULT_HOST = "https://ollama.com";
const DEFAULT_PRIMARY = "gemma4:31b-cloud";
// Default to no fallback — set LLM_FALLBACK_MODEL in .env.local once you've
// confirmed your Ollama Cloud plan includes the model you want as a backup.
const DEFAULT_FALLBACK: string | null = null;

function getApiKey(): string {
  const k = process.env.OLLAMA_API_KEY || process.env.Ollama_API_KEY;
  if (!k) throw new Error("OLLAMA_API_KEY is not set");
  return k;
}

let _client: Ollama | null = null;
function getClient(): Ollama {
  if (_client) return _client;
  _client = new Ollama({
    host: process.env.OLLAMA_HOST || DEFAULT_HOST,
    headers: { Authorization: `Bearer ${getApiKey()}` },
  });
  return _client;
}

export function primaryModel(): string {
  return process.env.LLM_PRIMARY_MODEL || DEFAULT_PRIMARY;
}

export function fallbackModel(): string | null {
  const v = process.env.LLM_FALLBACK_MODEL ?? DEFAULT_FALLBACK ?? "";
  return v && v !== "none" ? v : null;
}

export type ChatInput = {
  /** Tag used in log lines so multi-stage runs are easy to trace. */
  stage: string;
  system: string;
  user: string;
  /** When set, asks the model to return JSON matching this shape (Ollama "format"). */
  json?: object | "json";
  /** Gemma 4 thinking control. Ignored by models that don't support it. */
  think?: boolean | "high" | "medium" | "low";
  /** Hard ceiling on response tokens. */
  maxTokens?: number;
  /** Sampling temperature. Defaults to 0.7. */
  temperature?: number;
  /**
   * Per-call wall-clock cap in ms. When the unattended cron collapses all
   * pipeline stages into ONE serverless invocation, a single degraded Ollama
   * Cloud round-trip could otherwise consume the whole 300s budget. Opt-in so
   * the interactive SSE routes keep their original (uncapped) behavior; the
   * cron pipeline passes explicit caps per stage. On timeout the call rejects
   * with a clear error (the underlying socket is abandoned — fine on
   * serverless, where the function is killed at maxDuration anyway).
   */
  timeoutMs?: number;
};

export type ChatResult = {
  text: string;
  thinking?: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  /** True when the primary model failed and we succeeded on the fallback. */
  usedFallback: boolean;
};

function buildRequest(model: string, input: ChatInput): ChatRequest & { stream: false } {
  return {
    model,
    stream: false,
    messages: [
      { role: "system", content: input.system },
      { role: "user", content: input.user },
    ],
    ...(input.json ? { format: input.json } : {}),
    ...(input.think !== undefined ? { think: input.think } : {}),
    options: {
      temperature: input.temperature ?? 0.7,
      ...(input.maxTokens ? { num_predict: input.maxTokens } : {}),
    },
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

async function callOnce(model: string, input: ChatInput): Promise<ChatResult> {
  const start = Date.now();
  const client = getClient();
  const chatPromise = client.chat(buildRequest(model, input));
  const res = input.timeoutMs
    ? await withTimeout(chatPromise, input.timeoutMs, `[llm:${input.stage}] ${model}`)
    : await chatPromise;
  return {
    text: res.message.content ?? "",
    thinking: res.message.thinking,
    model,
    promptTokens: res.prompt_eval_count ?? 0,
    completionTokens: res.eval_count ?? 0,
    durationMs: Date.now() - start,
    usedFallback: false,
  };
}

/**
 * Transient network/server hiccups (resets, 429/5xx, dropped sockets) deserve
 * ONE in-place retry of the primary before we give up or fall back. Our own
 * wall-clock timeout is deliberately NOT transient — the caller owns that
 * budget (the cron splits 300s across stages), so re-spending it here could
 * starve later stages.
 */
function isTransientLlmError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes("timed out after")) return false;
  return /fetch failed|econnreset|econnrefused|etimedout|socket|network|terminated|unexpected end|aborted|429|too many requests|50[0-4]|bad gateway|service unavailable|gateway timeout|overloaded/.test(msg);
}

export async function chat(input: ChatInput): Promise<ChatResult> {
  const primary = primaryModel();
  const fallback = fallbackModel();

  let primaryErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await callOnce(primary, input);
      logUsage(input.stage, r);
      return r;
    } catch (err) {
      primaryErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt === 0 && isTransientLlmError(err)) {
        console.warn(`[llm:${input.stage}] primary ${primary} transient failure (${msg}); retrying once`);
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      break;
    }
  }

  const primaryMsg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
  if (!fallback) {
    console.error(`[llm:${input.stage}] primary ${primary} failed and no fallback configured: ${primaryMsg}`);
    throw primaryErr;
  }
  console.warn(`[llm:${input.stage}] primary ${primary} failed (${primaryMsg}); retrying on fallback ${fallback}`);
  const r = await callOnce(fallback, input);
  r.usedFallback = true;
  logUsage(input.stage, r);
  return r;
}

function logUsage(stage: string, r: ChatResult) {
  const tag = r.usedFallback ? `[llm:${stage}:fallback]` : `[llm:${stage}]`;
  console.log(
    `${tag} ${r.model} — ${r.promptTokens} in / ${r.completionTokens} out tokens in ${r.durationMs}ms`,
  );
}
