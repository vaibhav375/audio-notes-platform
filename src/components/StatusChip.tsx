import { statusLabel, statusTone } from "@/lib/status";
import type { NoteView } from "@/lib/serialize";

export function StatusChip({ note }: { note: NoteView }) {
  const tone = statusTone(note.status);
  return (
    <span className={`chip chip--${tone}`}>
      <span className="chip__dot" aria-hidden="true" />
      {statusLabel(note)}
    </span>
  );
}
