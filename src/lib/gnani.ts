import { env } from "@/lib/env";

/**
 * Thin client over Gnani's STT Batch job API (https://api.vachana.ai).
 *
 * Every note goes through the batch endpoints rather than the synchronous
 * `/stt/v3` endpoint. The sync endpoint caps at 60 seconds of audio, so routing
 * short files through it would mean two code paths, two failure models, and a
 * cliff that a 61-second file falls off with no warning. See /architecture.
 */

export type GnaniJobStatus =
  | "CREATED"
  | "STARTING"
  | "QUEUED"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "PARTIAL_FAILURE"
  | "FAILED"
  | "START_FAILED"
  | "CANCELLED";

/** Statuses after which polling should stop. */
const TERMINAL: ReadonlySet<GnaniJobStatus> = new Set([
  "COMPLETED",
  "PARTIAL_FAILURE",
  "FAILED",
  "START_FAILED",
  "CANCELLED",
]);

export function isTerminal(status: string | null | undefined): boolean {
  return !!status && TERMINAL.has(status as GnaniJobStatus);
}

export type GnaniProgress = {
  total_files?: number;
  completed_files?: number;
  failed_files?: number;
  in_progress_files?: number;
  queued_files?: number;
  cancelled_files?: number;
};

export type GnaniJob = {
  job_id: string;
  status: GnaniJobStatus;
  progress?: GnaniProgress;
  message?: string;
  error_message?: string;
  /** Where this API reports why a job was stopped, e.g. "ReadTimeout: ". */
  cancel_reason?: string | null;
};

export type GnaniJobFile = {
  file_id: string;
  original_path?: string;
  status: string;
  /** The files endpoint returns this as a string, e.g. "131.50". */
  duration_seconds?: string | number;
  transcript_url?: string;
  error_message?: string | null;
};

export type GnaniTranscript = {
  file_id: string;
  job_id: string;
  language_code: string;
  duration_seconds?: string | number;
  full_transcript: string;
  segments?: unknown[];
};

/** Raised for any non-2xx response, carrying enough detail to show a user. */
export class GnaniError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly retryable: boolean;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = "GnaniError";
    this.status = status;
    this.code = code;
    // 429 and 5xx are transient; 4xx generally means the request itself is bad.
    this.retryable = status === 429 || (status >= 500 && status <= 599);
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;

async function request<T>(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = init;
  const url = `${env.gnaniBaseUrl}${path}`;

  const response = await fetchWithRetry(url, {
    ...rest,
    timeoutMs,
    headers: {
      "X-API-Key-ID": env.gnaniApiKey,
      ...(rest.headers ?? {}),
    },
  });

  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON body; fall through and use the raw text in the error message.
  }

  if (!response.ok) {
    const record = (body ?? {}) as Record<string, unknown>;
    const message =
      (typeof record.message === "string" && record.message) ||
      (typeof record.error === "string" && record.error) ||
      (typeof record.detail === "string" && record.detail) ||
      text.slice(0, 300) ||
      `Gnani API returned ${response.status}`;
    const code =
      typeof record.code === "string"
        ? record.code
        : typeof record.error_code === "string"
          ? record.error_code
          : typeof record.error === "string" && typeof record.message === "string"
            ? record.error
            : null;
    throw new GnaniError(message, response.status, code);
  }

  return body as T;
}

/**
 * Retries transient failures (429, 5xx, network errors, timeouts) with
 * exponential backoff. Deliberately modest: this runs inside a request handler,
 * not a worker, so it must finish well inside the platform's function timeout.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit & { timeoutMs: number },
  attempts = 3,
): Promise<Response> {
  const { timeoutMs, ...rest } = init;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...rest, signal: controller.signal });
      if (response.status === 429 || response.status >= 500) {
        lastError = new GnaniError(
          `Gnani API returned ${response.status}`,
          response.status,
        );
        if (attempt < attempts - 1) continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) break;
    } finally {
      clearTimeout(timer);
    }
  }

  if (lastError instanceof GnaniError) throw lastError;
  const detail =
    lastError instanceof Error && lastError.name === "AbortError"
      ? `timed out after ${timeoutMs}ms`
      : lastError instanceof Error
        ? lastError.message
        : "unknown network error";
  throw new GnaniError(`Could not reach the Gnani API (${detail}).`, 503);
}

export type CreateJobOptions = {
  /** Publicly readable HTTPS URLs, in playback order. */
  audioUrls: string[];
  languageCode: string;
  callbackUrl?: string | null;
  /** Separate two speakers. The API caps num_speakers at 2. */
  diarize?: boolean;
};

/**
 * Creates a batch job pointing at an already-uploaded object.
 *
 * The audio lives in blob storage at a public HTTPS URL, so the `cloud_storage`
 * source lets Gnani pull the bytes directly. That keeps the file off our
 * request path entirely — no re-uploading a 10 MB body through a serverless
 * function that caps request bodies well below that.
 */
export async function createJob(options: CreateJobOptions): Promise<GnaniJob> {
  const config: Record<string, unknown> = {
    model: env.gnaniModel,
    language_code: options.languageCode,
    mode: "transcribe",
  };

  if (options.diarize) {
    config.with_diarization = true;
    // Required whenever diarization is on, and the API rejects anything above 2.
    config.num_speakers = 2;
  }

  const body: Record<string, unknown> = {
    config,
    source: {
      type: "cloud_storage",
      auth: { mode: "public" },
      paths: options.audioUrls,
    },
  };

  if (options.callbackUrl) body.callback_url = options.callbackUrl;

  return request<GnaniJob>("/stt/v3/batch/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Creating a job does not start it; this call kicks off processing. */
export async function startJob(jobId: string): Promise<GnaniJob> {
  return request<GnaniJob>(
    `/stt/v3/batch/jobs/${encodeURIComponent(jobId)}/start`,
    { method: "POST" },
  );
}

export async function getJob(jobId: string): Promise<GnaniJob> {
  return request<GnaniJob>(`/stt/v3/batch/jobs/${encodeURIComponent(jobId)}`, {
    method: "GET",
    cache: "no-store",
  });
}

export async function getJobFiles(jobId: string): Promise<GnaniJobFile[]> {
  const body = await request<
    { data?: GnaniJobFile[]; files?: GnaniJobFile[] } | GnaniJobFile[]
  >(`/stt/v3/batch/jobs/${encodeURIComponent(jobId)}/files`, {
    method: "GET",
    cache: "no-store",
  });
  if (Array.isArray(body)) return body;
  // The live API returns `{ job_id, data: [...], pagination }`; `files` is
  // accepted as well so a future rename does not silently return nothing.
  return body.data ?? body.files ?? [];
}

/** Parses the duration field, which is a string on some endpoints. */
export function parseDuration(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

/**
 * Downloads a transcript from its pre-signed URL. These URLs expire after an
 * hour, which is why the result is persisted immediately by the caller rather
 * than re-fetched on demand.
 */
export async function downloadTranscript(
  transcriptUrl: string,
): Promise<GnaniTranscript> {
  const response = await fetchWithRetry(transcriptUrl, {
    method: "GET",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    cache: "no-store",
  });
  if (!response.ok) {
    throw new GnaniError(
      `Could not download the transcript (HTTP ${response.status}). ` +
        `Pre-signed transcript links expire one hour after the job completes.`,
      response.status,
    );
  }
  return (await response.json()) as GnaniTranscript;
}
