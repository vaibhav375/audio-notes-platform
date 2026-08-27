import { describe, expect, it } from "vitest";
import type { Note, Segment } from "@/lib/db/schema";
import { exportFilename, render } from "@/lib/export";

function segment(over: Partial<Segment> = {}): Segment {
  return {
    segment_id: 0,
    start_time: 0,
    end_time: 1.5,
    text: "hello there",
    speaker_id: null,
    ...over,
  };
}

function note(over: Partial<Note> = {}): Note {
  return {
    id: "n1",
    originalFilename: "meeting.mp3",
    originalBytes: 1000,
    uploadedBytes: 1000,
    contentType: "audio/mpeg",
    transcoded: "false",
    durationSeconds: 90,
    languageCode: "en-IN",
    diarize: false,
    audioUrl: "https://example.public.blob.vercel-storage.com/a.mp3",
    audioPathname: "a.mp3",
    status: "completed",
    gnaniJobId: "job",
    gnaniFileId: "file",
    gnaniStatus: "COMPLETED",
    progress: null,
    transcript: "hello there",
    segments: [segment()],
    summary: "## Overview\nA summary.",
    errorMessage: null,
    failureStage: null,
    summaryAttempts: 1,
    createdAt: new Date("2026-01-02T03:04:05Z"),
    updatedAt: new Date("2026-01-02T03:04:05Z"),
    lastPolledAt: null,
    ...over,
  } as Note;
}

describe("SRT export", () => {
  it("numbers cues from 1 and uses comma before milliseconds", () => {
    const srt = render(
      note({
        segments: [
          segment({ segment_id: 0, start_time: 0, end_time: 1.5, text: "one" }),
          segment({ segment_id: 1, start_time: 1.5, end_time: 3.25, text: "two" }),
        ],
      }),
      "srt",
    );

    expect(srt).toContain("1\n00:00:00,000 --> 00:00:01,500\none");
    expect(srt).toContain("2\n00:00:01,500 --> 00:00:03,250\ntwo");
  });

  it("crosses the hour boundary correctly", () => {
    const srt = render(
      note({ segments: [segment({ start_time: 3661.5, end_time: 3662 })] }),
      "srt",
    );
    expect(srt).toContain("01:01:01,500 --> 01:01:02,000");
  });

  it("never emits a zero-length cue, which players skip", () => {
    const srt = render(
      note({ segments: [segment({ start_time: 10, end_time: 10 })] }),
      "srt",
    );
    expect(srt).toContain("00:00:10,000 --> 00:00:11,000");
  });
});

describe("VTT export", () => {
  it("starts with the WEBVTT header and uses a dot before milliseconds", () => {
    const vtt = render(note(), "vtt");
    expect(vtt.startsWith("WEBVTT\n")).toBe(true);
    expect(vtt).toContain("00:00:00.000 --> 00:00:01.500");
  });
});

describe("text export", () => {
  it("prefixes each line with its timestamp", () => {
    const txt = render(
      note({ segments: [segment({ start_time: 65, text: "later line" })] }),
      "txt",
    );
    expect(txt).toContain("[1:05] later line");
  });

  it("labels speakers only when diarization was requested", () => {
    const withSpeakers = { segments: [segment({ speaker_id: 2 })] };
    expect(render(note({ ...withSpeakers, diarize: true }), "txt")).toContain(
      "Speaker 2: hello there",
    );
    expect(render(note({ ...withSpeakers, diarize: false }), "txt")).not.toContain(
      "Speaker 2",
    );
  });

  it("falls back to the flat transcript when there are no segments", () => {
    const txt = render(note({ segments: null, transcript: "flat text" }), "txt");
    expect(txt).toContain("flat text");
  });
});

describe("markdown export", () => {
  it("includes the summary above the transcript", () => {
    const md = render(note(), "md");
    expect(md.indexOf("A summary.")).toBeLessThan(md.indexOf("## Transcript"));
  });
});

describe("export filenames", () => {
  it("swaps the extension and strips characters that break the header", () => {
    expect(exportFilename(note({ originalFilename: "team sync.mp3" }), "srt")).toBe(
      "team sync.srt",
    );
    expect(
      exportFilename(note({ originalFilename: 'we"ird/name.wav' }), "txt"),
    ).toBe("we_ird_name.txt");
  });

  it("falls back to a default when nothing usable remains", () => {
    expect(exportFilename(note({ originalFilename: "***.mp3" }), "txt")).toBe(
      "_.txt",
    );
  });
});
