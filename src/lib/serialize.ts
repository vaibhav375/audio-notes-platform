import type { Note, Segment } from "@/lib/db/schema";
import { STALL_WARNING_MS } from "@/lib/pipeline";

/** Shape sent to the browser. Excludes bulky segment data from list responses. */
export type NoteView = {
  id: string;
  originalFilename: string;
  originalBytes: number;
  uploadedBytes: number;
  transcoded: boolean;
  durationSeconds: number | null;
  languageCode: string;
  diarize: boolean;
  audioUrl: string;
  status: Note["status"];
  gnaniJobId: string | null;
  gnaniStatus: string | null;
  progress: Note["progress"];
  transcript: string | null;
  segments: Segment[] | null;
  summary: string | null;
  errorMessage: string | null;
  failureStage: Note["failureStage"];
  createdAt: string;
  updatedAt: string;
  /** True when processing is taking unusually long but has not failed. */
  slow: boolean;
};

export function toView(note: Note, options: { withText?: boolean } = {}): NoteView {
  const withText = options.withText ?? true;
  const active = note.status === "transcribing" || note.status === "summarizing";

  return {
    id: note.id,
    originalFilename: note.originalFilename,
    originalBytes: note.originalBytes,
    uploadedBytes: note.uploadedBytes,
    transcoded: note.transcoded === "true",
    durationSeconds: note.durationSeconds,
    languageCode: note.languageCode,
    diarize: note.diarize,
    audioUrl: note.audioUrl,
    status: note.status,
    gnaniJobId: note.gnaniJobId,
    gnaniStatus: note.gnaniStatus,
    progress: note.progress,
    transcript: withText ? note.transcript : null,
    // Segments are bulky; the library list has no use for them.
    segments: withText ? note.segments : null,
    summary: withText ? note.summary : null,
    errorMessage: note.errorMessage,
    failureStage: note.failureStage,
    createdAt: new Date(note.createdAt).toISOString(),
    updatedAt: new Date(note.updatedAt).toISOString(),
    slow:
      active &&
      Date.now() - new Date(note.createdAt).getTime() > STALL_WARNING_MS,
  };
}
