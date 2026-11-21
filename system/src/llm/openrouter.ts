/** A minimal OpenRouter chat-completions client: Node's built-in fetch, bounded retries, a deadline, a cost tally. */
import type { EvidenceDocument } from "../evidence.js";
import { warn } from "../diagnostics.js";
import { messages, SCHEMAS, type TaskKind } from "./prompts.js";

export const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
/** Pinned for reproducibility; a run reports the model it used. */
export const MODEL = "anthropic/claude-haiku-5.5";

/** Reads one document for one task. Resolves to the parsed JSON answer, or undefined when no usable answer came back. */
export interface DocumentReader {
  read(kind: TaskKind, doc: EvidenceDocument, customerName: string): Promise<unknown>;
  /** One line for stderr describing calls made and their cost. */
  summary(): string;
}

interface Options {
  readonly apiKey: string;
  readonly model?: string;
  /** Stop starting new calls after this many milliseconds from creation. */
  readonly budgetMs?: number;
  readonly timeoutMs?: number;
  readonly attempts?: number;
  readonly fetchImpl?: typeof fetch;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The JSON object in a model reply. Tolerates a Markdown code fence, reasoning text in <think> tags, or prose
 * around the object, as models without structured output sometimes produce.
 */
export function parseReply(content: unknown): unknown {
  if (typeof content !== "string") return undefined;
  const text = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(text); } catch { /* fall through to the outermost object */ }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return undefined; }
}

export function openRouterReader(options: Options): DocumentReader {
  const { apiKey, model = MODEL, budgetMs = 20 * 60_000, timeoutMs = 45_000, attempts = 3, fetchImpl = fetch } = options;
  const deadline = Date.now() + budgetMs;
  let calls = 0, failures = 0, skipped = 0, promptTokens = 0, completionTokens = 0, cost = 0;

  async function read(kind: TaskKind, doc: EvidenceDocument, customerName: string): Promise<unknown> {
    if (Date.now() > deadline) { skipped++; return undefined; }
    const { name, schema } = SCHEMAS[kind];
    const body = JSON.stringify({
      model, messages: messages(kind, doc, customerName),
      response_format: { type: "json_schema", json_schema: { name, strict: true, schema } },
      // Ignored by models that do not support them; the answer is validated against the document either way.
      temperature: 0, seed: 0, max_tokens: 4000,
      ...(model.startsWith("anthropic/") ? { provider: { order: ["anthropic"] } } : {}), usage: { include: true },
    });
    for (let attempt = 1; attempt <= attempts; attempt++) {
      calls++;
      try {
        const response = await fetchImpl(ENDPOINT, {
          method: "POST", body, signal: AbortSignal.timeout(timeoutMs),
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        });
        if (response.status === 429 || response.status >= 500) {
          // Free-tier rate limits are per minute: wait longer before retrying a 429.
          if (response.status === 429 && attempt < attempts) await sleep(10_000 * attempt);
          throw new Error(`HTTP ${response.status}`);
        }
        if (!response.ok) { failures++; warn(`model call for ${doc.metadata.doc_id} failed with HTTP ${response.status}`); return undefined; }
        const json = await response.json() as { choices?: { message?: { content?: unknown } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number } };
        promptTokens += json.usage?.prompt_tokens ?? 0;
        completionTokens += json.usage?.completion_tokens ?? 0;
        cost += json.usage?.cost ?? 0;
        const parsed = parseReply(json.choices?.[0]?.message?.content);
        if (parsed === undefined) failures++;
        return parsed;
      } catch (error) {
        if (attempt === attempts || Date.now() > deadline) {
          failures++;
          warn(`model call for ${doc.metadata.doc_id} failed: ${error instanceof Error ? error.message : String(error)}`);
          return undefined;
        }
        await sleep(2_000 * attempt);
      }
    }
    return undefined;
  }

  return {
    read,
    summary: () => `model ${model}: ${calls} calls, ${failures} without a usable answer, ${skipped} skipped after the time budget, `
      + `${promptTokens} prompt and ${completionTokens} completion tokens, US$${cost.toFixed(4)}`,
  };
}
