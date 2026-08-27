import type { Note, Segment } from "@/lib/db/schema";

/** Formats a recording can be downloaded in. */
export const EXPORT_FORMATS = ["txt", "md", "srt", "vtt"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export function isExportFormat(value: string): value is ExportFormat {
  return (EXPORT_FORMATS as readonly string[]).includes(value);
}

const MIME: Record<ExportFormat, string> = {
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  srt: "application/x-subrip; charset=utf-8",
  vtt: "text/vtt; charset=utf-8",
};

export function contentType(format: ExportFormat): string {
  return MIME[format];
}

/** Strips the extension and anything awkward in a Content-Disposition header. */
export function exportFilename(note: Note, format: ExportFormat): string {
  const base =
    note.originalFilename.replace(/\.[^./\\]+$/, "").replace(/[^\w\- ]+/g, "_") ||
    "recording";
  return `${base}.${format}`;
}

export function render(note: Note, format: ExportFormat): string {
  switch (format) {
    case "txt":
      return renderText(note);
    case "md":
      return renderMarkdown(note);
    case "srt":
      return renderSrt(note.segments ?? []);
    case "vtt":
      return renderVtt(note.segments ?? []);
  }
}

function renderText(note: Note): string {
  const lines = [
    note.originalFilename,
    `Recorded language: ${note.languageCode}`,
    note.durationSeconds != null ? `Duration: ${clock(note.durationSeconds)}` : null,
    `Transcribed: ${new Date(note.createdAt).toISOString()}`,
    "",
  ].filter((line): line is string => line !== null);

  if (note.segments?.length) {
    for (const segment of note.segments) {
      const speaker =
        note.diarize && segment.speaker_id != null
          ? `Speaker ${segment.speaker_id}: `
          : "";
      lines.push(`[${clock(segment.start_time)}] ${speaker}${segment.text}`);
    }
  } else {
    lines.push(note.transcript ?? "");
  }

  return `${lines.join("\n")}\n`;
}

function renderMarkdown(note: Note): string {
  const parts = [
    `# ${note.originalFilename}`,
    "",
    [
      note.durationSeconds != null ? `**Duration:** ${clock(note.durationSeconds)}` : null,
      `**Language:** ${note.languageCode}`,
      `**Transcribed:** ${new Date(note.createdAt).toISOString().slice(0, 10)}`,
    ]
      .filter(Boolean)
      .join(" · "),
    "",
  ];

  if (note.summary) parts.push(note.summary.trim(), "");

  parts.push("## Transcript", "");

  if (note.segments?.length) {
    for (const segment of note.segments) {
      const speaker =
        note.diarize && segment.speaker_id != null
          ? `**Speaker ${segment.speaker_id}** `
          : "";
      parts.push(`\`${clock(segment.start_time)}\` ${speaker}${segment.text}`, "");
    }
  } else {
    parts.push(note.transcript ?? "_No transcript._", "");
  }

  return parts.join("\n");
}

/** SubRip. Indices are 1-based and timestamps use a comma before milliseconds. */
function renderSrt(segments: Segment[]): string {
  return (
    segments
      .map((segment, index) =>
        [
          index + 1,
          `${stamp(segment.start_time, ",")} --> ${stamp(endOf(segment), ",")}`,
          segment.text,
        ].join("\n"),
      )
      .join("\n\n") + "\n"
  );
}

function renderVtt(segments: Segment[]): string {
  return (
    "WEBVTT\n\n" +
    segments
      .map((segment) =>
        [
          `${stamp(segment.start_time, ".")} --> ${stamp(endOf(segment), ".")}`,
          segment.text,
        ].join("\n"),
      )
      .join("\n\n") +
    "\n"
  );
}

/** Guards against zero-length cues, which some players skip entirely. */
function endOf(segment: Segment): number {
  return segment.end_time > segment.start_time
    ? segment.end_time
    : segment.start_time + 1;
}

function stamp(seconds: number, msSeparator: "," | "."): string {
  const total = Math.max(0, seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.round((total - Math.floor(total)) * 1000);
  return (
    `${pad(h)}:${pad(m)}:${pad(s)}${msSeparator}` + String(ms).padStart(3, "0")
  );
}

function clock(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
