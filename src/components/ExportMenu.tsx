"use client";

import type { NoteView } from "@/lib/serialize";

/**
 * Download links, not fetch-and-blob: the server sets Content-Disposition, so
 * the browser handles the save the way it handles any other download.
 */
export function ExportMenu({ note }: { note: NoteView }) {
  const hasTimings = !!note.segments?.length;

  const formats: { format: string; label: string; available: boolean; title: string }[] = [
    { format: "txt", label: "Text", available: true, title: "Timestamped plain text" },
    { format: "md", label: "Markdown", available: true, title: "Summary and transcript as Markdown" },
    {
      format: "srt",
      label: "SRT",
      available: hasTimings,
      title: hasTimings
        ? "Subtitles built from the segment timings"
        : "Needs per-segment timings, which this recording does not have",
    },
    {
      format: "vtt",
      label: "VTT",
      available: hasTimings,
      title: hasTimings
        ? "WebVTT subtitles built from the segment timings"
        : "Needs per-segment timings, which this recording does not have",
    },
  ];

  return (
    <div className="exports">
      <span className="exports__label">Download</span>
      {formats.map((item) =>
        item.available ? (
          <a
            key={item.format}
            className="exports__link"
            href={`/api/notes/${note.id}/export?format=${item.format}`}
            title={item.title}
          >
            {item.label}
          </a>
        ) : (
          <span
            key={item.format}
            className="exports__link exports__link--off"
            title={item.title}
            aria-disabled="true"
          >
            {item.label}
          </span>
        ),
      )}
    </div>
  );
}
