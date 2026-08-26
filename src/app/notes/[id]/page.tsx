import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getNote } from "@/lib/pipeline";
import { toView } from "@/lib/serialize";
import { NoteDetail } from "@/components/NoteDetail";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const note = await getNote(id).catch(() => null);
  return { title: note ? `${note.originalFilename} · Audio Notes` : "Audio Notes" };
}

/**
 * Reopening a past upload reads straight from the database, so the transcript
 * and summary render on first paint. Gnani's transcript URLs expire an hour
 * after a job finishes, which is exactly why nothing here is re-fetched from
 * the provider.
 */
export default async function NotePage({ params }: Props) {
  const { id } = await params;

  let note;
  try {
    note = await getNote(id);
  } catch (error) {
    return (
      <div className="notice notice--error" role="alert" style={{ marginTop: "2rem" }}>
        <span className="notice__title">Could not open this recording</span>
        <span>{error instanceof Error ? error.message : "Unknown error."}</span>
      </div>
    );
  }

  if (!note) notFound();

  return <NoteDetail initial={toView(note)} />;
}
