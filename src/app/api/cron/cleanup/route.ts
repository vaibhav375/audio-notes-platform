import { del } from "@vercel/blob";
import { and, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { notes } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { log } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Audio older than this is deleted; transcripts and summaries are kept. */
const RETENTION_DAYS = 30;

/**
 * Deletes aged audio while keeping every transcript and summary.
 *
 * The audio is the expensive thing to store and the least often revisited; the
 * text is what people come back for. A note whose audio has been swept keeps
 * its transcript, its summary and its place in the library, and simply loses
 * playback.
 *
 * Runs on a schedule (see vercel.json) and is also callable by hand with the
 * same secret the webhook uses.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const authorised =
    // Vercel signs its own scheduled invocations.
    request.headers.get("x-vercel-cron") !== null ||
    (!!env.webhookSecret && url.searchParams.get("secret") === env.webhookSecret);

  if (!authorised) {
    return Response.json({ error: "Unauthorised." }, { status: 401 });
  }

  const dryRun = url.searchParams.get("dryRun") === "1";
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

  try {
    const stale = await db()
      .select()
      .from(notes)
      .where(and(lt(notes.createdAt, cutoff), isNotNull(notes.audioUrl)))
      .limit(50);

    if (dryRun) {
      return Response.json({
        dryRun: true,
        retentionDays: RETENTION_DAYS,
        wouldDelete: stale.map((note) => ({
          id: note.id,
          filename: note.originalFilename,
          parts: note.parts?.length ?? 1,
        })),
      });
    }

    let deleted = 0;
    let failed = 0;

    for (const note of stale) {
      const urls = note.parts?.length
        ? note.parts.map((part) => part.url)
        : [note.audioUrl];

      try {
        await del(urls);
        // Blank the references so a swept note never renders a dead player.
        await db()
          .update(notes)
          .set({
            audioUrl: "",
            audioPathname: "",
            parts: null,
            updatedAt: new Date(),
          })
          .where(sql`id = ${note.id}`);
        deleted += 1;
        log.info("retention.swept", { noteId: note.id, parts: urls.length });
      } catch (error) {
        failed += 1;
        log.error("retention.failed", {
          noteId: note.id,
          reason: error instanceof Error ? error.message : "unknown",
        });
      }
    }

    log.info("retention.run", { considered: stale.length, deleted, failed });
    return Response.json({ retentionDays: RETENTION_DAYS, deleted, failed });
  } catch (error) {
    log.error("retention.error", {
      reason: error instanceof Error ? error.message : "unknown",
    });
    return Response.json(
      { error: error instanceof Error ? error.message : "Cleanup failed." },
      { status: 500 },
    );
  }
}
