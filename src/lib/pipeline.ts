import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  notes,
  type AudioPart,
  type JobProgress,
  type Note,
  type Segment,
  type SliceJob,
} from "@/lib/db/schema";
import { env } from "@/lib/env";
import { MAX_BATCH_FILES } from "@/lib/audio/prepare";
import {
  createJob,
  downloadTranscript,
  getJob,
  getJobFiles,
  GnaniError,
  isTerminal,
  parseDuration,
  startJob,
  transcribeSlice,
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

/**
 * How many times transcription is resubmitted after a provider-side start
 * failure. START_FAILED with a read timeout is not a statement about the audio
 * — it is what this API returns when it is rate limiting or briefly unwell, and
 * the same file submitted again later goes through.
 */
export const MAX_TRANSCRIPTION_ATTEMPTS = 4;

/** Wait between resubmissions, so a retry cannot make rate limiting worse. */
const RETRY_BACKOFF_MS = 90_000;

/** Provider-side conditions that say nothing about the file itself. */
function looksTransient(reason: string | null | undefined): boolean {
  if (!reason) return true;
  return /timeout|rate|throttl|temporar|unavailable|capacity|try again/i.test(reason);
}

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

/**
 * Switches a recording to the synchronous path.
 *
 * Nothing is transcribed here — the slices are transcribed a few at a time by
 * the reconciler, so no single request has to carry a whole recording.
 */
async function beginSyncTranscription(
  note: Note,
  sliceCount: number,
): Promise<Note> {
  log.info("note.sync_transcription", { noteId: note.id, slices: sliceCount });
  return patch(note.id, {
    transcribeMode: "sync",
    status: "transcribing",
    jobs: null,
    gnaniJobId: null,
    gnaniStatus: null,
    sliceTranscripts: new Array<string | null>(sliceCount).fill(null),
    progress: {
      totalFiles: sliceCount,
      completedFiles: 0,
      failedFiles: 0,
      inProgressFiles: sliceCount,
      queuedFiles: 0,
    },
    lastPolledAt: new Date(),
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
  const urls = audioUrlsFor(note);

  // Too many slices for one job, or the batch path is switched off: go straight
  // to transcribing slice by slice.
  if (
    env.transcribeMode === "sync" ||
    (env.transcribeMode === "auto" && urls.length > MAX_BATCH_FILES)
  ) {
    return beginSyncTranscription(note, urls.length);
  }

  try {
    const jobs: SliceJob[] = [];

    // Every slice in one job, which is what the batch API is for.
    const job = await createJob({
      audioUrls: urls,
      languageCode: note.languageCode,
      callbackUrl: callbackUrl(),
      diarize: note.diarize,
    });
    // A created job sits idle until it is explicitly started.
    const started = await startJob(job.job_id);
    jobs.push({
      jobId: job.job_id,
      partIndex: 0,
      status: started.status ?? job.status,
    });

    log.info("note.jobs_started", {
      noteId: note.id,
      jobs: jobs.length,
      language: note.languageCode,
      diarize: note.diarize,
    });

    return patch(note.id, {
      jobs,
      transcribeMode: "batch",
      gnaniJobId: jobs[0]?.jobId ?? null,
      gnaniStatus: jobs[0]?.status ?? null,
      status: "transcribing",
      progress: {
        totalFiles: urls.length,
        completedFiles: 0,
        failedFiles: 0,
        inProgressFiles: urls.length,
        queuedFiles: 0,
      },
      lastPolledAt: new Date(),
    });
  } catch (error) {
    // Could not even submit the job: the synchronous path is a different code
    // path on the provider's side and may well be healthy.
    if (env.transcribeMode === "auto" && error instanceof GnaniError) {
      log.warn("note.batch_submit_failed", {
        noteId: note.id,
        reason: error.message,
      });
      return beginSyncTranscription(note, urls.length);
    }
    if (error instanceof GnaniError) {
      // Rate limiting during submission is worth waiting out, not failing on.
      if (
        error.status === 429 &&
        note.transcriptionAttempts < MAX_TRANSCRIPTION_ATTEMPTS
      ) {
        log.warn("note.submit_rate_limited", {
          noteId: note.id,
          attempt: note.transcriptionAttempts + 1,
        });
        return patch(note.id, {
          status: "uploaded",
          jobs: null,
          gnaniJobId: null,
          transcriptionAttempts: note.transcriptionAttempts + 1,
          lastPolledAt: new Date(),
        });
      }
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
    note =
      note.transcribeMode === "sync"
        ? await advanceSyncTranscription(note)
        : await pollTranscription(note);
    if (note.status !== "summarizing") return note;
  }

  if (note.status === "summarizing") {
    note = await runSummary(note);
  }

  return note;
}

/** Slices transcribed per invocation, sized to finish well inside the timeout. */
const SLICES_PER_PASS = 8;

/**
 * Transcribes the next few slices through the synchronous endpoint.
 *
 * Returns as soon as its budget is spent, having saved what it finished. The
 * next poll picks up where this one stopped, so a recording of any length is
 * transcribed across as many requests as it needs and progress is real
 * throughout rather than jumping from nothing to everything.
 */
async function advanceSyncTranscription(note: Note): Promise<Note> {
  const parts: AudioPart[] = note.parts?.length
    ? [...note.parts].sort((a, b) => a.offsetSeconds - b.offsetSeconds)
    : [
        {
          url: note.audioUrl,
          pathname: note.audioPathname,
          bytes: note.uploadedBytes,
          offsetSeconds: 0,
          durationSeconds: note.durationSeconds ?? 0,
        },
      ];

  const results = [...(note.sliceTranscripts ?? new Array(parts.length).fill(null))];

  let done = 0;
  for (let index = 0; index < parts.length && done < SLICES_PER_PASS; index += 1) {
    if (results[index] !== null) continue;
    done += 1;

    try {
      const { transcript } = await transcribeSlice(parts[index].url, note.languageCode);
      results[index] = transcript;
    } catch (error) {
      if (error instanceof GnaniError && error.retryable) {
        // Save what did finish and let the next poll resume from here.
        return patch(note.id, {
          sliceTranscripts: results,
          progress: sliceProgress(results),
          lastPolledAt: new Date(),
        });
      }
      return fail(
        note.id,
        "transcription",
        error instanceof GnaniError
          ? describeGnaniError(error)
          : "Could not transcribe part of this recording.",
      );
    }
  }

  const remaining = results.some((entry) => entry === null);
  if (remaining) {
    return patch(note.id, {
      sliceTranscripts: results,
      progress: sliceProgress(results),
      lastPolledAt: new Date(),
    });
  }

  // Every slice is in. Assemble the recording, timings and all.
  const stitched = stitch(
    results.map((text, index) => ({
      full_transcript: text ?? "",
      // The synchronous endpoint returns text only, so each slice becomes one
      // segment spanning its own span of the recording.
      segments: text?.trim()
        ? [
            {
              segment_id: index,
              start_time: 0,
              end_time: parts[index].durationSeconds,
              text: text.trim(),
            },
          ]
        : [],
    })),
    parts.map((part) => part.offsetSeconds),
  );

  log.info("note.transcribed", {
    noteId: note.id,
    mode: "sync",
    slices: parts.length,
    characters: stitched.transcript.length,
  });

  const [claimed] = await db()
    .update(notes)
    .set({
      status: "summarizing",
      transcript: stitched.transcript,
      segments: stitched.segments.length > 0 ? stitched.segments : null,
      sliceTranscripts: results,
      progress: sliceProgress(results),
      errorMessage: null,
      failureStage: null,
      updatedAt: new Date(),
    })
    .where(and(eq(notes.id, note.id), eq(notes.status, "transcribing")))
    .returning();

  return claimed ?? (await getNote(note.id)) ?? note;
}

function sliceProgress(results: (string | null)[]): JobProgress {
  const completed = results.filter((entry) => entry !== null).length;
  return {
    totalFiles: results.length,
    completedFiles: completed,
    failedFiles: 0,
    inProgressFiles: results.length - completed,
    queuedFiles: 0,
  };
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
    const reason =
      first.error_message ?? first.cancel_reason ?? first.message ?? null;

    // A start failure says nothing about the audio — it is what this API
    // returns when the batch pipeline is unwell. Telling the user their file is
    // corrupt would be both wrong and unactionable.
    const transient = first.status === "START_FAILED" && looksTransient(reason);

    // The synchronous endpoint is a separate code path on the provider's side
    // and is often healthy when the batch pipeline is not. Hand over to it
    // rather than retrying a route that has already failed.
    if (transient && env.transcribeMode === "auto") {
      log.warn("note.batch_failed_falling_back", {
        noteId: note.id,
        reason: reason ?? "unknown",
      });
      return beginSyncTranscription(note, audioUrlsFor(note).length);
    }

    const retryable =
      transient && note.transcriptionAttempts < MAX_TRANSCRIPTION_ATTEMPTS;

    if (retryable) {
      const since = note.lastPolledAt
        ? Date.now() - new Date(note.lastPolledAt).getTime()
        : Number.MAX_SAFE_INTEGER;
      if (since < RETRY_BACKOFF_MS) return note;

      log.warn("note.transcription_retrying", {
        noteId: note.id,
        attempt: note.transcriptionAttempts + 1,
        reason: reason ?? "unknown",
      });

      // Back to `uploaded` so the next reconcile creates fresh jobs.
      return patch(note.id, {
        status: "uploaded",
        jobs: null,
        gnaniJobId: null,
        gnaniStatus: null,
        transcriptionAttempts: note.transcriptionAttempts + 1,
        lastPolledAt: new Date(),
      });
    }

    return fail(
      note.id,
      "transcription",
      reason
        ? `Gnani could not transcribe this recording: ${reason.trim() || first.status}`
        : states.length > 1
          ? `Transcription failed on one of the ${states.length} parts of this recording.`
          : "Gnani could not transcribe this recording. The file may be corrupt or in an unsupported format.",
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
