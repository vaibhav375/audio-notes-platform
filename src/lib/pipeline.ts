import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { notes, type JobProgress, type Note } from "@/lib/db/schema";
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
  type GnaniProgress,
} from "@/lib/gnani";
import { LlmError, summariseTranscript } from "@/lib/llm";

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
  return patch(id, {
    status: "failed",
    failureStage: stage,
    errorMessage: message,
  });
}

function normaliseProgress(progress?: GnaniProgress): JobProgress | null {
  if (!progress) return null;
  return {
    totalFiles: progress.total_files ?? 0,
    completedFiles: progress.completed_files ?? 0,
    failedFiles: progress.failed_files ?? 0,
    inProgressFiles: progress.in_progress_files ?? 0,
    queuedFiles: progress.queued_files ?? 0,
  };
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
    const job = await createJob({
      audioUrl: note.audioUrl,
      languageCode: note.languageCode,
      callbackUrl: callbackUrl(),
    });

    await patch(note.id, {
      gnaniJobId: job.job_id,
      gnaniStatus: job.status,
      status: "transcribing",
    });

    // A created job sits idle until it is explicitly started.
    const started = await startJob(job.job_id);

    return patch(note.id, {
      gnaniStatus: started.status ?? job.status,
      progress: normaliseProgress(started.progress),
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
  const jobId = note.gnaniJobId;
  if (!jobId) return note;

  let job;
  try {
    job = await getJob(jobId);
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

  const progress = normaliseProgress(job.progress);
  note = await patch(note.id, {
    gnaniStatus: job.status,
    progress,
    lastPolledAt: new Date(),
  });

  if (!isTerminal(job.status)) return expireIfStuck(note);

  if (job.status === "FAILED" || job.status === "START_FAILED") {
    return fail(
      note.id,
      "transcription",
      job.error_message ??
        job.message ??
        "Gnani could not transcribe this recording. The file may be corrupt or in an unsupported format.",
    );
  }

  if (job.status === "CANCELLED") {
    return fail(note.id, "transcription", "The transcription job was cancelled.");
  }

  // COMPLETED or PARTIAL_FAILURE: inspect the per-file result.
  let files;
  try {
    files = await getJobFiles(jobId);
  } catch (error) {
    if (error instanceof GnaniError && error.retryable) return expireIfStuck(note);
    throw error;
  }

  const file = files[0];
  if (!file) {
    return fail(
      note.id,
      "transcription",
      "Gnani reported the job as finished but returned no files for it.",
    );
  }

  if (!file.transcript_url) {
    return fail(
      note.id,
      "transcription",
      file.error_message ??
        "Gnani finished the job without producing a transcript for this file.",
    );
  }

  let transcript;
  try {
    transcript = await downloadTranscript(file.transcript_url);
  } catch (error) {
    if (error instanceof GnaniError && error.retryable) return expireIfStuck(note);
    return fail(
      note.id,
      "transcription",
      error instanceof Error ? error.message : "Could not download the transcript.",
    );
  }

  const fullTranscript = (transcript.full_transcript ?? "").trim();

  // Claim the transition, so two concurrent pollers cannot both summarise.
  const [claimed] = await db()
    .update(notes)
    .set({
      status: "summarizing",
      transcript: fullTranscript,
      segments: transcript.segments ?? null,
      gnaniFileId: file.file_id,
      durationSeconds:
        note.durationSeconds ??
        parseDuration(file.duration_seconds) ??
        parseDuration(transcript.duration_seconds),
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

  try {
    const { summary } = await summariseTranscript(transcript);
    return patch(note.id, {
      summary,
      status: "completed",
      errorMessage: null,
      failureStage: null,
    });
  } catch (error) {
    const message =
      error instanceof LlmError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Unknown summarisation error.";
    return fail(note.id, "summary", message);
  }
}

export async function getNote(id: string): Promise<Note | null> {
  const [row] = await db().select().from(notes).where(eq(notes.id, id)).limit(1);
  return row ?? null;
}
