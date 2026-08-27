import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  notes,
  type Note,
  type Segment,
  type SliceJob,
} from "@/lib/db/schema";
import { env } from "@/lib/env";
import {
  createJob,
  downloadTranscript,
  getJob,
  getJobFiles,
  GnaniError,
  isTerminal,
  parseDuration,
  startJob,
  type GnaniJobFile,
} from "@/lib/gnani";
import { LlmError, summariseTranscript } from "@/lib/llm";
import { log } from "@/lib/log";

/**
 * Drives a note from `uploaded` to `completed`.
 *
 * There is no long-lived worker process: this function is the single place that
 * advances state, and it is invoked from three directions — the create handler,
 * Gnani's webhook, and the status endpoint the browser polls. All three are
 * idempotent, so it does not matter which one gets there first, and a note is
 * never stranded just because the user closed their tab.
 */

/** After this long without reaching a terminal state, the UI warns the user. */
export const STALL_WARNING_MS = 5 * 60 * 1000;

/** Hard ceiling; past this a stuck job is marked failed so it stops polling. */
export const STALL_FAILURE_MS = 30 * 60 * 1000;

/**
 * How many times a transient summarisation failure is retried before the note
 * is marked failed. Free-tier token-per-minute limits are the common cause, and
 * they clear on their own, so giving up on the first 429 would be wrong.
 */
export const MAX_SUMMARY_ATTEMPTS = 6;

async function patch(id: string, values: Partial<Note>): Promise<Note> {
  const [row] = await db()
    .update(notes)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(notes.id, id))
    .returning();
  return row;
}

async function fail(
  id: string,
  stage: "upload" | "transcription" | "summary",
  message: string,
): Promise<Note> {
  log.error("note.failed", { noteId: id, stage, reason: message });
  return patch(id, {
    status: "failed",
    failureStage: stage,
    errorMessage: message,
  });
}

/** Every slice of a recording, in order. Falls back for pre-chunking rows. */
function audioUrlsFor(note: Note): string[] {
  if (note.parts?.length) {
    return [...note.parts]
      .sort((a, b) => a.offsetSeconds - b.offsetSeconds)
      .map((part) => part.url);
  }
  return [note.audioUrl];
}

/** Builds the webhook URL, or null when this deployment cannot receive one. */
function callbackUrl(): string | null {
  const origin = env.publicOrigin;
  if (!origin || !env.webhookSecret) return null;
  if (!origin.startsWith("https://")) return null;
  return `${origin}/api/gnani/webhook?secret=${encodeURIComponent(env.webhookSecret)}`;
}

/**
 * Creates and starts the Gnani batch job for a freshly uploaded note.
 * Runs inside the upload request so the user learns immediately whether their
 * file was accepted by the ASR provider.
 */
export async function beginTranscription(note: Note): Promise<Note> {
  try {
    const urls = audioUrlsFor(note);
    const jobs: SliceJob[] = [];

    // One job per slice. The batch API advertises many files per job, but a
    // two-file job is cancelled with a read timeout every time, whether the
    // files are pulled from storage or posted directly. Single-file jobs are
    // reliable, so that is the unit.
    for (const [partIndex, url] of urls.entries()) {
      const job = await createJob({
        audioUrls: [url],
        languageCode: note.languageCode,
        callbackUrl: callbackUrl(),
        diarize: note.diarize,
      });
      // A created job sits idle until it is explicitly started.
      const started = await startJob(job.job_id);
      jobs.push({
        jobId: job.job_id,
        partIndex,
        status: started.status ?? job.status,
      });
    }

    log.info("note.jobs_started", {
      noteId: note.id,
      jobs: jobs.length,
      language: note.languageCode,
      diarize: note.diarize,
    });

    return patch(note.id, {
      jobs,
      gnaniJobId: jobs[0]?.jobId ?? null,
      gnaniStatus: jobs[0]?.status ?? null,
      status: "transcribing",
      progress: {
        totalFiles: jobs.length,
        completedFiles: 0,
        failedFiles: 0,
        inProgressFiles: jobs.length,
        queuedFiles: 0,
      },
      lastPolledAt: new Date(),
    });
  } catch (error) {
    if (error instanceof GnaniError) {
      return fail(note.id, "transcription", describeGnaniError(error));
    }
    return fail(
      note.id,
      "transcription",
      error instanceof Error ? error.message : "Unknown transcription error.",
    );
  }
}

/** Turns an API error into something worth showing a user. */
function describeGnaniError(error: GnaniError): string {
  if (error.status === 401) {
    return "The Gnani API rejected our credentials. The server's GNANI_API_KEY is missing or invalid.";
  }
  if (error.code === "UNSUPPORTED_LANGUAGE") {
    return "Gnani does not support the selected language for this model.";
  }
  if (error.status === 429) {
    return "Gnani's API is rate limiting this account. Try again in a few minutes.";
  }
  if (error.status === 400) {
    return `Gnani rejected the audio file: ${error.message}`;
  }
  return `Gnani API error (HTTP ${error.status}): ${error.message}`;
}

/**
 * Advances a note by one step. Safe to call repeatedly and concurrently.
 */
export async function reconcileNote(input: Note): Promise<Note> {
  let note = input;

  if (note.status === "completed" || note.status === "failed") return note;

  if (note.status === "uploaded" || !note.gnaniJobId) {
    note = await beginTranscription(note);
    if (note.status === "failed" || !note.gnaniJobId) return note;
  }

  if (note.status === "transcribing") {
    note = await pollTranscription(note);
    if (note.status !== "summarizing") return note;
  }

  if (note.status === "summarizing") {
    note = await runSummary(note);
  }

  return note;
}

async function pollTranscription(note: Note): Promise<Note> {
  const sliceJobs = note.jobs?.length
    ? note.jobs
    : note.gnaniJobId
      ? [{ jobId: note.gnaniJobId, partIndex: 0, status: note.gnaniStatus }]
      : [];

  if (sliceJobs.length === 0) return note;

  let states;
  try {
    states = await Promise.all(sliceJobs.map((slice) => getJob(slice.jobId)));
  } catch (error) {
    // A transient polling failure should not destroy an in-flight job; leave the
    // note alone and let the next poll try again, unless we have waited absurdly
    // long already.
    if (error instanceof GnaniError && error.retryable) {
      return expireIfStuck(note);
    }
    return fail(
      note.id,
      "transcription",
      error instanceof GnaniError
        ? describeGnaniError(error)
        : "Could not read the transcription job status.",
    );
  }

  // Progress across slices is real progress: a recording in four slices reports
  // genuine quarters, which a single job never could.
  const completed = states.filter((s) => s.status === "COMPLETED").length;
  const broken = states.filter(
    (s) => s.status === "FAILED" || s.status === "START_FAILED" || s.status === "CANCELLED",
  );
  const queued = states.filter(
    (s) => (s.progress?.queued_files ?? 0) > 0 && (s.progress?.in_progress_files ?? 0) === 0,
  ).length;

  note = await patch(note.id, {
    jobs: sliceJobs.map((slice, index) => ({
      ...slice,
      status: states[index].status,
    })),
    gnaniStatus: states[0].status,
    progress: {
      totalFiles: states.length,
      completedFiles: completed,
      failedFiles: broken.length,
      inProgressFiles: states.length - completed - broken.length - queued,
      queuedFiles: queued,
    },
    lastPolledAt: new Date(),
  });

  if (broken.length > 0) {
    const first = broken[0];
    return fail(
      note.id,
      "transcription",
      first.error_message ??
        first.message ??
        (states.length > 1
          ? `Transcription failed on one of the ${states.length} parts of this recording.`
          : "Gnani could not transcribe this recording. The file may be corrupt or in an unsupported format."),
    );
  }

  if (!states.every((state) => isTerminal(state.status))) {
    return expireIfStuck(note);
  }

  // Every slice is terminal and none failed: gather the per-slice results.
  let files: GnaniJobFile[];
  try {
    const perJob = await Promise.all(
      sliceJobs.map((slice) => getJobFiles(slice.jobId)),
    );
    files = perJob.map((entries) => entries[0]).filter(Boolean);
  } catch (error) {
    if (error instanceof GnaniError && error.retryable) return expireIfStuck(note);
    throw error;
  }

  if (files.length === 0) {
    return fail(
      note.id,
      "transcription",
      "Gnani reported the job as finished but returned no files for it.",
    );
  }

  // One file per slice, gathered in slice order already.
  const ordered = files;

  const missing = ordered.find((file) => !file.transcript_url);
  if (missing) {
    return fail(
      note.id,
      "transcription",
      missing.error_message ??
        "Gnani finished the job without producing a transcript for part of this recording.",
    );
  }

  let downloaded;
  try {
    // Sequential rather than parallel: transcripts are small, and a burst of
    // parallel fetches is a good way to get rate limited on a long recording.
    downloaded = [];
    for (const file of ordered) {
      downloaded.push(await downloadTranscript(file.transcript_url!));
    }
  } catch (error) {
    if (error instanceof GnaniError && error.retryable) return expireIfStuck(note);
    return fail(
      note.id,
      "transcription",
      error instanceof Error ? error.message : "Could not download the transcript.",
    );
  }

  const stitched = stitch(downloaded, offsetsFor(ordered, note));
  log.info("note.transcribed", {
    noteId: note.id,
    files: ordered.length,
    segments: stitched.segments.length,
    characters: stitched.transcript.length,
  });
  const fullTranscript = stitched.transcript;

  // Claim the transition, so two concurrent pollers cannot both summarise.
  const [claimed] = await db()
    .update(notes)
    .set({
      status: "summarizing",
      transcript: fullTranscript,
      segments: stitched.segments.length > 0 ? stitched.segments : null,
      gnaniFileId: ordered[0].file_id,
      durationSeconds:
        note.durationSeconds ??
        (ordered.reduce(
          (total, entry) => total + (parseDuration(entry.duration_seconds) ?? 0),
          0,
        ) ||
          null),
      errorMessage: null,
      failureStage: null,
      updatedAt: new Date(),
    })
    .where(and(eq(notes.id, note.id), eq(notes.status, "transcribing")))
    .returning();

  if (!claimed) {
    // Another invocation already moved this note on; re-read and continue.
    return (await getNote(note.id)) ?? note;
  }

  return claimed;
}

/**
 * Marks a note failed once it has been in flight implausibly long, so the UI
 * stops polling forever against a job that will never finish.
 */
async function expireIfStuck(note: Note): Promise<Note> {
  const age = Date.now() - new Date(note.createdAt).getTime();
  if (age < STALL_FAILURE_MS) return note;
  return fail(
    note.id,
    "transcription",
    "Transcription did not finish within 30 minutes. The job appears to be stuck on Gnani's side.",
  );
}

/**
 * Runs the LLM summary over a stored transcript.
 *
 * A summary failure never discards the transcript: the transcript is already
 * persisted by this point, so the note keeps it and the detail page offers a
 * retry of just this stage.
 */
export async function runSummary(note: Note): Promise<Note> {
  const transcript = note.transcript?.trim();
  if (!transcript) {
    return fail(note.id, "summary", "There is no transcript to summarise.");
  }

  // Claim the attempt. Concurrent pollers both reach this point, and without a
  // conditional claim the loser can overwrite a good summary with its own
  // failure. Only the invocation that increments the counter proceeds.
  const [claimed] = await db()
    .update(notes)
    .set({
      summaryAttempts: note.summaryAttempts + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(notes.id, note.id),
        eq(notes.status, "summarizing"),
        eq(notes.summaryAttempts, note.summaryAttempts),
      ),
    )
    .returning();

  if (!claimed) {
    // Another invocation is already summarising this note, or it has moved on.
    return (await getNote(note.id)) ?? note;
  }

  try {
    const started = Date.now();
    const { summary } = await summariseTranscript(transcript);
    log.info("note.summarised", {
      noteId: note.id,
      attempt: claimed.summaryAttempts,
      ms: Date.now() - started,
      transcriptChars: transcript.length,
    });

    const [completed] = await db()
      .update(notes)
      .set({
        summary,
        status: "completed",
        errorMessage: null,
        failureStage: null,
        updatedAt: new Date(),
      })
      .where(and(eq(notes.id, note.id), eq(notes.status, "summarizing")))
      .returning();

    return completed ?? (await getNote(note.id)) ?? claimed;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown summarisation error.";
    const transient =
      error instanceof LlmError &&
      error.retryable &&
      claimed.summaryAttempts < MAX_SUMMARY_ATTEMPTS;

    if (transient) {
      // Stay in `summarizing` so the next poll picks it up. The note is not
      // failed — it is waiting out a limit that clears on its own.
      log.warn("note.summary_retrying", {
        noteId: note.id,
        attempt: claimed.summaryAttempts,
        reason: message,
      });
      return patch(note.id, { errorMessage: message });
    }

    const [failed] = await db()
      .update(notes)
      .set({
        status: "failed",
        failureStage: "summary",
        errorMessage: message,
        updatedAt: new Date(),
      })
      .where(and(eq(notes.id, note.id), eq(notes.status, "summarizing")))
      .returning();

    return failed ?? (await getNote(note.id)) ?? claimed;
  }
}

/**
 * Keeps only the fields the UI uses. Provider payloads carry several keys that
 * come back null on every request, and storing them would bloat every row.
 */
/** Start time of each file within the whole recording. */
function offsetsFor(files: GnaniJobFile[], note: Note): number[] {
  const parts = note.parts?.length
    ? [...note.parts].sort((a, b) => a.offsetSeconds - b.offsetSeconds)
    : [];

  if (parts.length === files.length) {
    return parts.map((part) => part.offsetSeconds);
  }

  // No stored parts (a row from before chunking) — accumulate the reported
  // durations instead so timings still line up.
  let running = 0;
  return files.map((file) => {
    const start = running;
    running += parseDuration(file.duration_seconds) ?? 0;
    return start;
  });
}

/**
 * Joins per-slice transcripts into one recording.
 *
 * Segment times arrive relative to their own slice, so each is shifted by where
 * that slice starts. Without this a click on a line in the third chunk would
 * seek to the wrong place entirely.
 */
export function stitch(
  transcripts: { full_transcript?: string; segments?: unknown }[],
  offsets: number[],
): { transcript: string; segments: Segment[] } {
  const texts: string[] = [];
  const segments: Segment[] = [];

  transcripts.forEach((transcript, index) => {
    const offset = offsets[index] ?? 0;
    const text = (transcript.full_transcript ?? "").trim();
    if (text) texts.push(text);

    for (const segment of normaliseSegments(transcript.segments) ?? []) {
      segments.push({
        ...segment,
        segment_id: segments.length,
        start_time: segment.start_time + offset,
        end_time: segment.end_time + offset,
      });
    }
  });

  return { transcript: texts.join(" ").trim(), segments };
}

export function normaliseSegments(raw: unknown): Segment[] | null {
  if (!Array.isArray(raw)) return null;
  const segments: Segment[] = [];
  raw.forEach((entry, index) => {
    const s = entry as Record<string, unknown>;
    const start = Number(s.start_time);
    const end = Number(s.end_time);
    const text = typeof s.text === "string" ? s.text.trim() : "";
    if (!text || !Number.isFinite(start)) return;
    // Number(null) is 0, which would render as a real "Speaker 0".
    const speaker =
      s.speaker_id === null || s.speaker_id === undefined
        ? Number.NaN
        : Number(s.speaker_id);
    segments.push({
      segment_id: Number.isFinite(Number(s.segment_id)) ? Number(s.segment_id) : index,
      start_time: start,
      end_time: Number.isFinite(end) ? end : start,
      text,
      speaker_id: Number.isFinite(speaker) ? speaker : null,
    });
  });
  return segments.length > 0 ? segments : null;
}

export async function getNote(id: string): Promise<Note | null> {
  const [row] = await db().select().from(notes).where(eq(notes.id, id)).limit(1);
  return row ?? null;
}
