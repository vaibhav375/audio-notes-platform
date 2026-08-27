import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

/**
 * Lifecycle of a note:
 *
 *   uploaded ──> transcribing ──> summarizing ──> completed
 *                    │                 │
 *                    └────────┬────────┘
 *                             v
 *                          failed
 *
 * `failed` is terminal but never destructive: whatever was produced before the
 * failure (e.g. a transcript that arrived but could not be summarised) stays on
 * the row so the detail page can show partial results and offer a retry.
 */
export const NOTE_STATUSES = [
  "uploaded",
  "transcribing",
  "summarizing",
  "completed",
  "failed",
] as const;

export type NoteStatus = (typeof NOTE_STATUSES)[number];

/** Which stage produced the error, so the UI can offer the right retry action. */
export const FAILURE_STAGES = ["upload", "transcription", "summary"] as const;
export type FailureStage = (typeof FAILURE_STAGES)[number];

/**
 * One utterance as returned by the ASR provider. Timings are what make the
 * transcript navigable, so they are kept rather than flattened away.
 */
export type Segment = {
  segment_id: number;
  start_time: number;
  end_time: number;
  text: string;
  speaker_id?: number | null;
};

/**
 * One uploaded slice of a recording. Recordings longer than the per-file limit
 * allows are split, so this is a list even when it holds a single entry.
 */
export type AudioPart = {
  url: string;
  pathname: string;
  bytes: number;
  /** Where this slice starts within the whole recording, in seconds. */
  offsetSeconds: number;
  durationSeconds: number;
};

/**
 * One provider job. A recording split into slices gets one job per slice: the
 * batch API documents up to 100 files per job, but a two-file job fails every
 * time with a read timeout, while single-file jobs are reliable.
 */
export type SliceJob = {
  jobId: string;
  /** Index of the slice in `parts` this job transcribes. */
  partIndex: number;
  status: string | null;
};

export type JobProgress = {
  totalFiles: number;
  completedFiles: number;
  failedFiles: number;
  inProgressFiles: number;
  queuedFiles: number;
};

export const notes = pgTable(
  "notes",
  {
    id: text("id").primaryKey(),

    // What the user gave us.
    originalFilename: text("original_filename").notNull(),
    originalBytes: integer("original_bytes").notNull(),
    /** Bytes actually shipped to Gnani, after client-side transcoding. */
    uploadedBytes: integer("uploaded_bytes").notNull(),
    /** MIME type of the object in blob storage. */
    contentType: text("content_type").notNull(),
    /** True when the browser re-encoded the file to fit the 10 MB batch cap. */
    transcoded: text("transcoded").notNull().default("false"),
    durationSeconds: integer("duration_seconds"),
    languageCode: text("language_code").notNull(),
    /** Whether the user asked for two-speaker separation on this recording. */
    diarize: boolean("diarize").notNull().default(false),

    // Where the audio bytes physically live. `audioUrl` is the first slice, and
    // is the whole recording whenever there is only one.
    audioUrl: text("audio_url").notNull(),
    audioPathname: text("audio_pathname").notNull(),
    /** Every slice, in order. Null on rows written before chunking existed. */
    parts: jsonb("parts").$type<AudioPart[]>(),

    // Pipeline state.
    status: text("status").$type<NoteStatus>().notNull().default("uploaded"),
    gnaniJobId: text("gnani_job_id"),
    /** Every provider job for this recording, in order. Batch path only. */
    jobs: jsonb("jobs").$type<SliceJob[]>(),
    /** Which transcription path this recording is using. */
    transcribeMode: text("transcribe_mode").$type<"batch" | "sync">(),
    /**
     * Per-slice text from the synchronous path, filled in as slices complete.
     * Transcribing a long recording takes more time than one request may run
     * for, so progress is persisted rather than held in memory.
     */
    sliceTranscripts: jsonb("slice_transcripts").$type<(string | null)[]>(),
    gnaniFileId: text("gnani_file_id"),
    gnaniStatus: text("gnani_status"),
    progress: jsonb("progress").$type<JobProgress>(),

    // Results.
    transcript: text("transcript"),
    segments: jsonb("segments").$type<Segment[]>(),
    summary: text("summary"),

    // Failure surface.
    errorMessage: text("error_message"),
    /** Summarisation attempts so far, so transient retries stay bounded. */
    summaryAttempts: integer("summary_attempts").notNull().default(0),
    /** Transcription attempts, for retrying a provider-side start failure. */
    transcriptionAttempts: integer("transcription_attempts").notNull().default(0),
    failureStage: text("failure_stage").$type<FailureStage>(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Last time a reconcile actually talked to Gnani about this note. */
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
  },
  (table) => [
    index("notes_created_at_idx").on(table.createdAt),
    index("notes_status_idx").on(table.status),
  ],
);

export type Note = typeof notes.$inferSelect;
export type NewNote = typeof notes.$inferInsert;
