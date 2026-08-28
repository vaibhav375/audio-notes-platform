/**
 * Checks that stored summaries are faithful to the transcripts they came from.
 *
 * A summary that reads well but drifts from its source is the failure most
 * likely to survive a demo unnoticed, so this exists to be run rather than
 * trusted. Two checks:
 *
 *   1. Structural — the sections the prompt asks for are present, nothing is
 *      empty, no reasoning block leaked through.
 *   2. Grounding — a model reads the transcript and the summary and reports
 *      claims the transcript does not support.
 *
 * The grounding judge is deliberately a *different* model family from the one
 * that writes the summaries. A model grading its own output is a weak signal;
 * agreement between two families is a much stronger one, and disagreement is
 * worth looking at by hand.
 *
 * Usage:
 *   node scripts/audit-summaries.mjs [--url https://...] [--judge <model>]
 */

import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const APP = flag("url", process.env.AUDIT_APP_URL ?? "http://localhost:3000");
const JUDGE = flag("judge", "openai/gpt-oss-120b");
const LLM_BASE = process.env.LLM_BASE_URL ?? "https://api.groq.com/openai/v1";
const LLM_KEY = process.env.LLM_API_KEY;

const REQUIRED_SECTIONS = ["## overview", "## key points", "## action items"];

const JUDGE_PROMPT = `Audit whether a summary is faithful to the transcript it came from.
The transcript may be in any language; the summary is in English.

Reply with ONLY a JSON object, no prose and no code fence:
{"verdict":"GROUNDED|MINOR_DRIFT|UNSUPPORTED","unsupported":["quote"],"note":"one sentence"}

GROUNDED = every claim traces to the transcript.
MINOR_DRIFT = mostly grounded, but a detail is embellished, over-specific, or attributes an intention, apology or emotion the transcript never states.
UNSUPPORTED = claims with no basis in the transcript.

Be strict about invented names, numbers, causes, outcomes and speech acts.
Paraphrase and condensation are fine.`;

async function getJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.json();
}

function structuralProblems(note) {
  const transcript = (note.transcript ?? "").trim();
  const summary = (note.summary ?? "").trim();
  const problems = [];

  if (!transcript) problems.push("no transcript");
  if (!summary) return [...problems, "no summary"];
  if (/<think>/i.test(summary)) problems.push("reasoning block leaked");

  const lower = summary.toLowerCase();
  const missing = REQUIRED_SECTIONS.filter((s) => !lower.includes(s));
  if (missing.length) problems.push(`missing ${missing.join(", ")}`);

  return problems;
}

async function judge(note) {
  const response = await fetch(`${LLM_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LLM_KEY}`,
    },
    body: JSON.stringify({
      model: JUDGE,
      temperature: 0,
      // Reasoning models bill their private reasoning against this budget and
      // return it in a separate field, so a tight limit truncates the answer
      // rather than shortening it. Give it room and ask for less reasoning.
      max_tokens: 2500,
      reasoning_effort: "low",
      messages: [
        { role: "system", content: JUDGE_PROMPT },
        {
          role: "user",
          content: `TRANSCRIPT:\n${note.transcript.slice(0, 14000)}\n\nSUMMARY:\n${note.summary}`,
        },
      ],
    }),
  });

  const body = await response.json();
  const choice = body?.choices?.[0];
  const content = choice?.message?.content ?? "";

  if (choice?.finish_reason === "length") {
    return {
      verdict: "UNREADABLE",
      unsupported: [],
      note: "judge ran out of output tokens",
    };
  }
  // Models vary in how tidily they return JSON; take the first object present.
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return { verdict: "UNREADABLE", unsupported: [], note: content.slice(0, 120) };
  try {
    return JSON.parse(match[0]);
  } catch {
    return { verdict: "UNREADABLE", unsupported: [], note: match[0].slice(0, 120) };
  }
}

const { notes } = await getJson(`${APP}/api/notes`);
if (!notes?.length) {
  console.log("No recordings to audit.");
  process.exit(0);
}

console.log(`Auditing ${notes.length} recordings against ${APP}`);
console.log(`Grounding judge: ${JUDGE}\n`);

let structural = 0;
const verdicts = {};

for (const summaryRow of notes) {
  const { note } = await getJson(`${APP}/api/notes/${summaryRow.id}`);
  const name = note.originalFilename.slice(0, 32).padEnd(33);

  const problems = structuralProblems(note);
  if (problems.length) {
    structural += 1;
    console.log(`${name} STRUCTURE  ${problems.join("; ")}`);
    continue;
  }

  if (!LLM_KEY) {
    console.log(`${name} ok (structure only, LLM_API_KEY unset)`);
    continue;
  }

  const result = await judge(note);
  verdicts[result.verdict] = (verdicts[result.verdict] ?? 0) + 1;
  const flagged = result.unsupported?.length
    ? ` — ${result.unsupported.map((c) => `"${c}"`).join(", ")}`
    : "";
  console.log(`${name} ${String(result.verdict).padEnd(12)}${flagged}`);
  if (result.verdict !== "GROUNDED" && result.note) {
    console.log(`${" ".repeat(33)}   ${result.note}`);
  }

  // The free tier is rate limited per minute; pace the calls.
  await new Promise((resolve) => setTimeout(resolve, 8000));
}

console.log("\nStructural problems:", structural);
if (Object.keys(verdicts).length) console.log("Grounding:", verdicts);

// Anything unsupported is a failure worth blocking on; drift is worth reading.
process.exit(verdicts.UNSUPPORTED || structural ? 1 : 0);
