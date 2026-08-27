import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { notes } from "@/lib/db/schema";
import { beginTranscription, getNote, runSummary } from "@/lib/pipeline";
import { toView } from "@/lib/serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Context = { params: Promise<{ id: string }> };

/**
 * Retries whichever stage failed.
 *
 * A summary failure only re-runs the LLM call — the transcript is already
 * persisted and there is no reason to pay for transcription again. A
 * transcription failure re-submits the stored audio object as a fresh job.
 */
export async function POST(_request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;

  try {
    const note = await getNote(id);
    if (!note) {
      return Response.json({ error: "That upload does not exist." }, { status: 404 });
    }

    if (note.status !== "failed") {
      return Response.json(
        { error: "This upload has not failed, so there is nothing to retry." },
        { status: 409 },
      );
    }

    if (note.failureStage === "summary" && note.transcript) {
      const [reset] = await db()
        .update(notes)
        .set({
          status: "summarizing",
          errorMessage: null,
          failureStage: null,
          summaryAttempts: 0,
          updatedAt: new Date(),
        })
        .where(eq(notes.id, id))
        .returning();

      return Response.json({ note: toView(await runSummary(reset)) });
    }

    const [reset] = await db()
      .update(notes)
      .set({
        status: "uploaded",
        gnaniJobId: null,
        gnaniFileId: null,
        gnaniStatus: null,
        progress: null,
        errorMessage: null,
        failureStage: null,
        summaryAttempts: 0,
        lastPolledAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(notes.id, id))
      .returning();

    return Response.json({ note: toView(await beginTranscription(reset)) });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Retry failed." },
      { status: 500 },
    );
  }
}
