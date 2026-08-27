# Audio Notes

Upload a recording, get back a transcript from [Gnani.ai](https://gnani.ai)'s
speech-to-text API and an LLM-generated summary. Past uploads are kept and can
be reopened at any time.

**Live app:** <https://audio-notes-platform.vercel.app> · **Design writeup:** `/architecture` on the live app

---

## What it does

- Accepts audio files of two minutes and well beyond, in any format the browser
  can decode — MP3, WAV, M4A, AAC, FLAC, OGG, WebM.
- Re-encodes oversized files in the browser so they fit the 10 MB per-file limit
  of Gnani's batch API.
- Transcribes through Gnani's **STT Batch** job API, driven by a webhook with
  polling as a fallback.
- Summarises the transcript with an LLM and stores both.
- Shows real progress and real failure states throughout, with per-stage retry.
- **Navigable transcripts** — every line is timestamped and seeks the audio when
  clicked, with the spoken line highlighting as it plays.
- **Search** across every stored transcript and summary, with highlighted
  excerpts. Works in Devanagari as well as Latin scripts.
- **Exports** — timestamped text, Markdown, and SRT/WebVTT subtitles built from
  the real segment timings.
- **Nine Indian languages**, all verified against the live API: Hindi, Kannada,
  Tamil, Telugu, Malayalam, Marathi, Bengali, Gujarati and Indian English.
  Transcripts keep their own script; summaries come back in English.
- **Optional two-speaker separation** for interviews and support calls, with
  labels you can correct when the provider gets them wrong.
- **Long recordings are split into slices** and submitted as one multi-file job,
  so length never costs audio quality; transcripts are stitched back together
  with their timings realigned.
- **Summaries in passes** for long transcripts — mapped per section, then
  reduced — so nothing is truncated away.
- **Scheduled cleanup** deletes audio past a retention window and keeps the
  transcript and summary.

The engineering reasoning behind these choices lives on the `/architecture`
page of the running app. This file is for getting it running locally.

## Stack

| Layer | Choice |
| --- | --- |
| App | Next.js 16 (App Router), TypeScript |
| Database | Postgres (Neon) via Drizzle ORM |
| Object storage | Vercel Blob |
| Speech-to-text | Gnani STT Batch (`api.vachana.ai`) |
| Summarisation | Any OpenAI-compatible chat endpoint (Qwen on Groq in production) |
| Hosting | Vercel |

## Running locally

### 1. Install

```bash
git clone https://github.com/vaibhav375/audio-notes-platform.git
cd audio-notes-platform
npm install
```

### 2. Configure

```bash
cp .env.example .env.local
```

Fill in the values:

| Variable | Required | What it is |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string. A free [Neon](https://neon.tech) database works. |
| `BLOB_READ_WRITE_TOKEN` | yes | Vercel Blob token, from the Vercel dashboard under Storage → Blob. |
| `GNANI_API_KEY` | yes | From [gnani.ai/speech-to-text-api](https://gnani.ai/speech-to-text-api). |
| `GNANI_BASE_URL` | no | Defaults to `https://api.vachana.ai`. |
| `GNANI_MODEL` | no | Defaults to `gnani-prisma-v2.5`. |
| `GNANI_WEBHOOK_SECRET` | no | Long random string. Without it the webhook is not registered and the app relies on polling — which is the normal case locally, since Gnani cannot reach `localhost`. |
| `APP_ORIGIN` | no | Public origin used to build the webhook URL. Set automatically on Vercel. |
| `LLM_BASE_URL` | no | Defaults to Groq's OpenAI-compatible endpoint. |
| `LLM_API_KEY` | yes | Key for whichever endpoint `LLM_BASE_URL` points at. |
| `LLM_MODEL` | no | Defaults to `qwen/qwen3.8-27b`. |
| `NEXT_PUBLIC_REPO_URL` | no | Shown on the `/architecture` page. |

### 3. Create the schema

```bash
npm run db:push
```

### 4. Run

```bash
npm run dev
```

Open <http://localhost:3000>.

### 5. Tests

```bash
npm test
```

Covers the logic that carries the risk and needs no network: chunk planning,
transcript stitching, subtitle timing, segment parsing, summarisation passes and
search-excerpt handling.

## Summarising with a local model

Summarisation talks to any OpenAI-compatible `/chat/completions` endpoint, so a
local [Ollama](https://ollama.com) model can stand in for the hosted one:

```bash
ollama pull qwen2.5:7b
```

```dotenv
LLM_BASE_URL="http://localhost:11434/v1"
LLM_API_KEY="ollama"      # Ollama ignores the value, but one must be present
LLM_MODEL="qwen2.5:7b"
```

No code changes are needed — the provider is configuration, not source.

## Layout

```
src/
├─ app/
│  ├─ page.tsx                    upload form + library
│  ├─ notes/[id]/page.tsx         one recording: transcript, summary, retries
│  ├─ architecture/page.tsx       the design writeup
│  └─ api/
│     ├─ blob/upload/             issues direct-upload tokens
│     ├─ notes/                   list, and create-then-start-a-job
│     ├─ notes/[id]/              status poll, which also advances the pipeline
│     ├─ notes/[id]/retry/        re-runs whichever stage failed
│     └─ gnani/webhook/           job-completion callback
├─ components/                    uploader, library, detail view, shared UI
└─ lib/
   ├─ audio/prepare.ts            browser-side decode, validate, re-encode
   ├─ gnani.ts                    STT Batch client, with retry and backoff
   ├─ llm.ts                      summarisation
   ├─ pipeline.ts                 the state machine everything calls into
   └─ db/                         Drizzle schema and connection
```

## Deploying

The app is a standard Next.js project and deploys to Vercel with no build
configuration. It needs, in the project's environment variables: `DATABASE_URL`,
`GNANI_API_KEY`, `LLM_API_KEY`, and `GNANI_WEBHOOK_SECRET`. `BLOB_READ_WRITE_TOKEN`
is injected automatically once a Blob store is attached to the project.

Run `npm run db:push` against the production `DATABASE_URL` once, to create the
table, then create the search index:

```sql
CREATE INDEX IF NOT EXISTS notes_fts_idx ON notes
USING GIN (to_tsvector('simple',
  coalesce(transcript, '') || ' ' || coalesce(summary, '') || ' ' || original_filename));
```

`vercel.json` schedules the daily retention sweep at `/api/cron/cleanup`. It can
also be run by hand with `?secret=$GNANI_WEBHOOK_SECRET`, and inspected without
deleting anything using `&dryRun=1`.

## Notes

- No API keys are committed. `.env.example` lists every variable with
  placeholder values; real values live only in `.env.local` (untracked) and in
  the hosting platform's environment settings.
- There is no seeded or demo data. Every transcript and summary in the app comes
  from a real Gnani job and a real LLM call.
