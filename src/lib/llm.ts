import { env } from "@/lib/env";

/**
 * Summarisation against any OpenAI-compatible `/chat/completions` endpoint.
 *
 * Keeping the provider behind three env vars (LLM_BASE_URL / LLM_API_KEY /
 * LLM_MODEL) means the deployed app and a local Ollama instance run the exact
 * same code path — only configuration differs.
 */

export class LlmError extends Error {
  readonly retryable: boolean;
  /** Set when the service named a wait short enough to sit out inline. */
  readonly retryAfterSeconds: number | null;

  constructor(
    message: string,
    retryable = false,
    retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "LlmError";
    this.retryable = retryable;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Below this, a "transcript" is almost certainly silence or noise. */
const MIN_TRANSCRIPT_CHARS = 24;

/**
 * Longest transcript summarised in one call.
 *
 * Sized for the tokens-per-minute ceiling of a free tier rather than the model's
 * context window: roughly four characters per token puts this around 4k tokens,
 * which leaves room for the reply without tripping a rate limit on the first
 * request.
 */
const SINGLE_PASS_CHARS = 16_000;

/** Size of each slice when a transcript is summarised in passes. */
const PASS_CHARS = 12_000;

/**
 * Guard against a pathological number of passes. At this length the recording
 * is many hours long and a reduce over 40 notes is itself the wrong shape.
 */
const MAX_PASSES = 40;

const MAP_PROMPT = `You are taking notes on one section of a longer transcript.

List the substantive points in that section as bullets: decisions, facts,
numbers, names, questions raised, and anything asked of a named person.

Rules:
- Use only what this section says. Never infer what came before or after it.
- Automatic transcription makes mistakes, especially with numbers, names and units; if a figure looks implausible, describe it rather than asserting it.
- Output bullets only. No heading, no preamble, no closing line.`;

const SYSTEM_PROMPT = `You summarise transcripts of spoken audio recordings.

Write the summary as GitHub-flavoured Markdown with exactly these sections:

## Overview
Two or three sentences describing what the recording is about.

## Key points
Four to eight bullet points covering the substance of what was said.

## Action items
Concrete follow-ups or decisions, as bullets. Write "None identified." if there are none.

Rules:
- Use only what the transcript actually says. Never invent details, names, numbers or outcomes.
- Automatic transcription makes mistakes, especially with numbers, names and units; if a passage is garbled or a figure looks implausible, summarise around it rather than repeating it as fact.
- Do not add a preamble, a closing remark, or any section beyond the three above.`;

export type SummaryResult = {
  summary: string;
  model: string;
};

/**
 * Rate-limit responses name the wait in their message ("try again in 23.8275s").
 * Honouring it turns a hard failure into a pause, which matters on a free tier
 * with a low tokens-per-minute ceiling.
 */
function retryAfterSeconds(message: string): number | null {
  const match = /try again in ([\d.]+)\s*s/i.exec(message);
  if (!match) return null;
  const seconds = Number.parseFloat(match[1]);
  return Number.isFinite(seconds) ? seconds : null;
}

/** Leaves room inside the platform's function timeout for the retried call. */
const MAX_INLINE_WAIT_SECONDS = 25;

export async function summariseTranscript(
  transcript: string,
): Promise<SummaryResult> {
  const trimmed = transcript.trim();

  if (trimmed.length < MIN_TRANSCRIPT_CHARS) {
    throw new LlmError(
      "The transcript was too short to summarise — the recording may be silent, " +
        "or the spoken language may not match the language selected at upload.",
    );
  }

  if (trimmed.length <= SINGLE_PASS_CHARS) {
    return withRetry(() => callOnce(SYSTEM_PROMPT, trimmed));
  }

  // Map: notes on each slice. Reduce: one summary over those notes. This keeps
  // every request small enough to pass a rate limit, and means the middle of a
  // long recording is represented rather than truncated away.
  const passes = splitForPasses(trimmed).slice(0, MAX_PASSES);
  const notes: string[] = [];

  for (const [index, pass] of passes.entries()) {
    const { summary } = await withRetry(() =>
      callOnce(MAP_PROMPT, `Section ${index + 1} of ${passes.length}:\n\n${pass}`),
    );
    notes.push(summary);
  }

  const combined = notes
    .map((note, index) => `Section ${index + 1}:\n${note}`)
    .join("\n\n");

  return withRetry(() =>
    callOnce(
      SYSTEM_PROMPT,
      `These are ordered notes taken across one recording. Write the summary of the recording as a whole.\n\n${combined}`,
    ),
  );
}

/**
 * Splits a transcript into passes on sentence-ish boundaries where it can, so a
 * slice does not begin mid-thought. ASR output here is unpunctuated, so word
 * boundaries are the realistic fallback.
 */
export function splitForPasses(
  transcript: string,
  size: number = PASS_CHARS,
): string[] {
  const words = transcript.split(/\s+/).filter(Boolean);
  const passes: string[] = [];
  let current: string[] = [];
  let length = 0;

  for (const word of words) {
    if (length + word.length + 1 > size && current.length > 0) {
      passes.push(current.join(" "));
      current = [];
      length = 0;
    }
    current.push(word);
    length += word.length + 1;
  }

  if (current.length > 0) passes.push(current.join(" "));
  return passes;
}

async function withRetry(call: () => Promise<SummaryResult>): Promise<SummaryResult> {
  try {
    return await call();
  } catch (error) {
    // One inline retry, but only when the service told us how long to wait and
    // the wait fits inside the request budget.
    if (error instanceof LlmError && error.retryAfterSeconds != null) {
      await new Promise((resolve) =>
        setTimeout(resolve, error.retryAfterSeconds! * 1000 + 500),
      );
      return call();
    }
    throw error;
  }
}

async function callOnce(system: string, input: string): Promise<SummaryResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);

  let response: Response;
  try {
    response = await fetch(`${env.llmBaseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.llmApiKey}`,
      },
      body: JSON.stringify({
        model: env.llmModel,
        temperature: 0.2,
        max_tokens: 1200,
        messages: [
          { role: "system", content: system },
          { role: "user", content: input },
        ],
      }),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    throw new LlmError(
      timedOut
        ? "The summarisation request timed out after 60 seconds."
        : `Could not reach the summarisation service: ${
            error instanceof Error ? error.message : "unknown network error"
          }`,
      true,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();

  if (!response.ok) {
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      if (parsed.error?.message) detail = parsed.error.message;
    } catch {
      // Keep the raw body excerpt.
    }
    const wait = response.status === 429 ? retryAfterSeconds(detail) : null;
    throw new LlmError(
      `Summarisation failed (HTTP ${response.status}): ${detail}`,
      response.status === 429 || response.status >= 500,
      wait != null && wait <= MAX_INLINE_WAIT_SECONDS ? wait : null,
    );
  }

  const payload = JSON.parse(text) as {
    model?: string;
    choices?: { message?: { content?: string } }[];
  };

  const content = payload.choices?.[0]?.message?.content ?? "";
  const summary = stripReasoning(content).trim();

  if (!summary) {
    throw new LlmError("The summarisation service returned an empty response.", true);
  }

  return { summary, model: payload.model ?? env.llmModel };
}

/**
 * Qwen and other reasoning models may wrap their chain of thought in <think>
 * tags. Only the answer belongs in the stored summary.
 */
function stripReasoning(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/gi, "");
}
