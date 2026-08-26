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

  constructor(message: string, retryable = false) {
    super(message);
    this.name = "LlmError";
    this.retryable = retryable;
  }
}

/** Below this, a "transcript" is almost certainly silence or noise. */
const MIN_TRANSCRIPT_CHARS = 24;

/**
 * Transcripts of long recordings can exceed the context window. Truncating at a
 * generous character budget keeps a single call viable; chunk-and-reduce
 * summarisation is listed under future work on /architecture.
 */
const MAX_TRANSCRIPT_CHARS = 48_000;

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
- Automatic transcription makes mistakes; if a passage is garbled, summarise around it rather than guessing.
- Do not add a preamble, a closing remark, or any section beyond the three above.`;

export type SummaryResult = {
  summary: string;
  model: string;
};

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

  const input =
    trimmed.length > MAX_TRANSCRIPT_CHARS
      ? `${trimmed.slice(0, MAX_TRANSCRIPT_CHARS)}\n\n[transcript truncated for length]`
      : trimmed;

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
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Transcript:\n\n${input}` },
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
    throw new LlmError(
      `Summarisation failed (HTTP ${response.status}): ${detail}`,
      response.status === 429 || response.status >= 500,
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
