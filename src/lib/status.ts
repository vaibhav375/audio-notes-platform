import type { NoteView } from "@/lib/serialize";

export type Tone = "idle" | "live" | "done" | "failed";

/** Human-facing wording for each pipeline state. */
export function statusLabel(note: Pick<NoteView, "status" | "gnaniStatus">): string {
  switch (note.status) {
    case "uploaded":
      return "Queued";
    case "transcribing":
      return note.gnaniStatus === "IN_PROGRESS" ? "Transcribing" : "Preparing";
    case "summarizing":
      return "Summarising";
    case "completed":
      return "Ready";
    case "failed":
      return "Failed";
  }
}

export function statusTone(status: NoteView["status"]): Tone {
  if (status === "completed") return "done";
  if (status === "failed") return "failed";
  if (status === "uploaded") return "idle";
  return "live";
}

export function isActive(status: NoteView["status"]): boolean {
  return status === "uploaded" || status === "transcribing" || status === "summarizing";
}

/**
 * Coarse but honest completion estimate.
 *
 * Gnani reports progress per file and every job here holds exactly one file, so
 * its counters only ever read 0 or 1. The job's own lifecycle status is the
 * finer-grained signal, and it is what this maps.
 */
export function completionRatio(note: NoteView): number {
  switch (note.status) {
    case "uploaded":
      return 0.06;
    case "transcribing":
      switch (note.gnaniStatus) {
        case "CREATED":
          return 0.16;
        case "STARTING":
          return 0.26;
        case "QUEUED":
          return 0.38;
        case "IN_PROGRESS":
          return 0.62;
        default:
          return 0.2;
      }
    case "summarizing":
      return 0.85;
    case "completed":
      return 1;
    case "failed":
      return note.transcript ? 0.8 : 0.35;
  }
}

/** One line explaining what the system is doing right now, and why it may wait. */
export function statusDetail(note: NoteView): string | null {
  switch (note.status) {
    case "uploaded":
      return "Registering the recording with the transcription service.";
    case "transcribing":
      return note.gnaniStatus === "QUEUED"
        ? "Waiting in Gnani's batch queue. Longer recordings take longer to reach the front."
        : "Gnani is transcribing the audio. This runs in the background — you can leave this page.";
    case "summarizing":
      return "Transcript stored. Generating the summary.";
    default:
      return null;
  }
}

export function formatDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatWhen(iso: string): string {
  const date = new Date(iso);
  const diff = Date.now() - date.getTime();
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
