import { desc, inArray, lt, or, isNull, and } from "drizzle-orm";
import { db } from "@/lib/db";
import { notes } from "@/lib/db/schema";
import { GNANI_MAX_FILE_BYTES, SUPPORTED_LANGUAGES } from "@/lib/constants";
import { beginTranscription, reconcileNote } from "@/lib/pipeline";
import { toView } from "@/lib/serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const LANGUAGE_CODES = new Set(SUPPORTED_LANGUAGES.map((l) => l.code));

/** Only objects in our own blob store may be handed to the ASR provider. */
const ALLOWED_AUDIO_HOST = /\.public\.blob\.vercel-storage\.com$/;

/**
 * Lists past uploads, newest first.
 *
 * This also nudges along any note that has not been polled recently. Without a
 * standing worker process, a note whose owner closed their tab would otherwise
 * sit half-finished until someone reopened it; sweeping a few stale ones here
 * means simply visiting the app repairs them.
 */
export async function GET(): Promise<Response> {
  try {
    const staleCutoff = new Date(Date.now() - 60_000);

    const stale = await db()
      .select()
      .from(notes)
      .where(
        and(
          inArray(notes.status, ["uploaded", "transcribing", "summarizing"]),
          or(isNull(notes.lastPolledAt), lt(notes.lastPolledAt, staleCutoff)),
        ),
      )
      .orderBy(desc(notes.createdAt))
      .limit(3);

    await Promise.allSettled(stale.map((note) => reconcileNote(note)));

    const rows = await db()
      .select()
      .from(notes)
      .orderBy(desc(notes.createdAt))
      .limit(100);

    return Response.json({
      notes: rows.map((row) => toView(row, { withText: false })),
    });
  } catch (error) {
    return Response.json(
      { error: describe(error, "Could not load past uploads.") },
      { status: 500 },
    );
  }
}

type CreateBody = {
  audioUrl?: unknown;
  audioPathname?: unknown;
  originalFilename?: unknown;
  originalBytes?: unknown;
  uploadedBytes?: unknown;
  contentType?: unknown;
  transcoded?: unknown;
  durationSeconds?: unknown;
  languageCode?: unknown;
  diarize?: unknown;
};

/**
 * Registers an already-uploaded object and kicks off transcription.
 *
 * Job creation happens inside this request on purpose: by the time the browser
 * gets a response the user knows whether Gnani accepted the file, rather than
 * discovering a rejection minutes later from a background poll.
 */
export async function POST(request: Request): Promise<Response> {
  let body: CreateBody;
  try {
    body = (await request.json()) as CreateBody;
  } catch {
    return Response.json({ error: "Malformed request body." }, { status: 400 });
  }

  const audioUrl = str(body.audioUrl);
  const originalFilename = str(body.originalFilename);
  const languageCode = str(body.languageCode);
  const uploadedBytes = num(body.uploadedBytes);

  if (!audioUrl || !originalFilename || !languageCode || uploadedBytes == null) {
    return Response.json(
      { error: "Missing one of: audioUrl, originalFilename, languageCode, uploadedBytes." },
      { status: 400 },
    );
  }

  let host: string;
  try {
    const parsed = new URL(audioUrl);
    host = parsed.hostname;
    if (parsed.protocol !== "https:") throw new Error("not https");
  } catch {
    return Response.json({ error: "audioUrl is not a valid HTTPS URL." }, { status: 400 });
  }

  if (!ALLOWED_AUDIO_HOST.test(host)) {
    return Response.json(
      { error: "audioUrl must point at this application's own blob storage." },
      { status: 400 },
    );
  }

  if (!LANGUAGE_CODES.has(languageCode as (typeof SUPPORTED_LANGUAGES)[number]["code"])) {
    return Response.json({ error: `Unsupported language code "${languageCode}".` }, { status: 400 });
  }

  if (uploadedBytes > GNANI_MAX_FILE_BYTES) {
    return Response.json(
      {
        error:
          `The uploaded audio is ${(uploadedBytes / 1024 / 1024).toFixed(1)} MB, ` +
          `over the ${GNANI_MAX_FILE_BYTES / 1024 / 1024} MB per-file limit of Gnani's batch API.`,
      },
      { status: 413 },
    );
  }

  try {
    const [inserted] = await db()
      .insert(notes)
      .values({
        id: crypto.randomUUID(),
        originalFilename: originalFilename.slice(0, 200),
        originalBytes: num(body.originalBytes) ?? uploadedBytes,
        uploadedBytes,
        contentType: str(body.contentType) ?? "application/octet-stream",
        transcoded: body.transcoded === true ? "true" : "false",
        durationSeconds: num(body.durationSeconds),
        languageCode,
        diarize: body.diarize === true,
        audioUrl,
        audioPathname: str(body.audioPathname) ?? new URL(audioUrl).pathname.slice(1),
        status: "uploaded",
      })
      .returning();

    const started = await beginTranscription(inserted);
    return Response.json({ note: toView(started) }, { status: 201 });
  } catch (error) {
    return Response.json(
      { error: describe(error, "Could not register the upload.") },
      { status: 500 },
    );
  }
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

function describe(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    if (error.name === "ConfigError") return error.message;
    return `${fallback} (${error.message})`;
  }
  return fallback;
}
