import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { notes } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { reconcileNote } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Callback Gnani POSTs to when a batch job reaches a terminal state.
 *
 * The payload itself is treated only as a signal, never as the source of truth:
 * the handler re-reads the job from the API through the same reconcile path the
 * poller uses. That keeps one implementation of the state machine, and means a
 * forged or malformed callback cannot write results into the database.
 *
 * Authenticated by a shared secret in the query string, since Gnani's callback
 * configuration accepts a URL rather than a signing key.
 */
export async function POST(request: Request): Promise<Response> {
  const secret = new URL(request.url).searchParams.get("secret");

  if (!env.webhookSecret || secret !== env.webhookSecret) {
    return Response.json({ error: "Unauthorised." }, { status: 401 });
  }

  let payload: { job_id?: string; jobId?: string; data?: { job_id?: string } };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return Response.json({ error: "Malformed payload." }, { status: 400 });
  }

  const jobId = payload.job_id ?? payload.jobId ?? payload.data?.job_id;
  if (!jobId) {
    return Response.json({ error: "Payload contained no job_id." }, { status: 400 });
  }

  const [note] = await db()
    .select()
    .from(notes)
    .where(eq(notes.gnaniJobId, jobId))
    .limit(1);

  // Unknown job: acknowledge anyway so Gnani does not retry indefinitely.
  if (!note) return Response.json({ ok: true, matched: false });

  try {
    await reconcileNote(note);
  } catch {
    // Swallow: the browser's polling path will retry this note shortly.
    return Response.json({ ok: true, matched: true, reconciled: false });
  }

  return Response.json({ ok: true, matched: true, reconciled: true });
}
