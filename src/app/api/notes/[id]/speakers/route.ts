import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { notes } from "@/lib/db/schema";
import { getNote } from "@/lib/pipeline";
import { toView } from "@/lib/serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/**
 * Corrects a speaker label from one segment onwards.
 *
 * Diarization is the provider's guess and it misattributes turns. A listener
 * can hear the mistake immediately, so the correction they make is treated as
 * the truth and persisted over the provider's answer.
 */
export async function PATCH(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;

  let body: { fromSegmentId?: unknown; speakerId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Malformed request body." }, { status: 400 });
  }

  const fromSegmentId = Number(body.fromSegmentId);
  const speakerId = Number(body.speakerId);

  if (!Number.isFinite(fromSegmentId) || (speakerId !== 1 && speakerId !== 2)) {
    return Response.json(
      { error: "fromSegmentId must be a number and speakerId must be 1 or 2." },
      { status: 400 },
    );
  }

  const note = await getNote(id);
  if (!note) {
    return Response.json({ error: "That upload does not exist." }, { status: 404 });
  }
  if (!note.segments?.length) {
    return Response.json(
      { error: "This recording has no speaker labels to correct." },
      { status: 409 },
    );
  }

  const anchor = note.segments.find((s) => s.segment_id === fromSegmentId);
  if (!anchor) {
    return Response.json({ error: "No such segment." }, { status: 404 });
  }

  // Carry the correction forward across the run the provider labelled the same
  // way, which is the span that shares the mistake.
  const previous = anchor.speaker_id;
  const updated = note.segments.map((segment) =>
    segment.segment_id >= fromSegmentId && segment.speaker_id === previous
      ? { ...segment, speaker_id: speakerId }
      : segment,
  );

  const [saved] = await db()
    .update(notes)
    .set({ segments: updated, updatedAt: new Date() })
    .where(eq(notes.id, id))
    .returning();

  return Response.json({ note: toView(saved) });
}
