import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { notes } from "@/lib/db/schema";
import { getNote, reconcileNote } from "@/lib/pipeline";
import { toView } from "@/lib/serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Context = { params: Promise<{ id: string }> };

/**
 * Status endpoint the browser polls.
 *
 * Each poll also advances the pipeline, which makes polling the fallback engine
 * for the whole flow when Gnani's webhook cannot reach this deployment.
 */
export async function GET(_request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;

  try {
    const note = await getNote(id);
    if (!note) {
      return Response.json({ error: "That upload does not exist." }, { status: 404 });
    }

    const advanced = await reconcileNote(note);
    return Response.json({ note: toView(advanced) });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not read the status of this upload.",
      },
      { status: 500 },
    );
  }
}

export async function DELETE(_request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  try {
    await db().delete(notes).where(eq(notes.id, id));
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not delete." },
      { status: 500 },
    );
  }
}
