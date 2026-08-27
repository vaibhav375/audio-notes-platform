import { describe, expect, it } from "vitest";
import { CHUNK_SECONDS, chooseBitrate, planChunks } from "@/lib/audio/prepare";
import { stitch } from "@/lib/pipeline";
import { GNANI_MAX_FILE_BYTES } from "@/lib/constants";

function encodedBytes(seconds: number, kbps: number): number {
  return (seconds * kbps * 1000) / 8;
}

describe("chunk planning", () => {
  it("leaves a short recording as a single slice", () => {
    expect(planChunks(120)).toEqual([{ start: 0, end: 120 }]);
  });

  it("splits once the recording exceeds the slice length", () => {
    expect(planChunks(CHUNK_SECONDS + 1)).toHaveLength(2);
  });

  it("produces slices that are contiguous and cover the whole recording", () => {
    for (const duration of [61, 900, 901, 3600, 5400]) {
      const chunks = planChunks(duration);
      expect(chunks[0].start).toBe(0);
      expect(chunks[chunks.length - 1].end).toBeCloseTo(duration, 6);
      for (let i = 1; i < chunks.length; i += 1) {
        expect(chunks[i].start).toBeCloseTo(chunks[i - 1].end, 6);
      }
    }
  });

  it("divides evenly rather than leaving a tiny trailing slice", () => {
    // 15:04 would otherwise be a full slice plus a four second file.
    const chunks = planChunks(CHUNK_SECONDS + 4);
    const lengths = chunks.map((c) => c.end - c.start);
    expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThan(0.001);
  });

  it("keeps every slice inside the per-file limit at full quality", () => {
    // This is the guarantee chunking exists to provide: no duration, however
    // long, forces the bitrate down or breaches the cap.
    for (const duration of [120, 900, 3600, 5400, 3 * 3600, 10 * 3600]) {
      for (const chunk of planChunks(duration)) {
        const length = chunk.end - chunk.start;
        expect(chooseBitrate(length)).toBe(64);
        expect(encodedBytes(length, 64)).toBeLessThanOrEqual(GNANI_MAX_FILE_BYTES);
      }
    }
  });

  it("stays within the 100 files a single job accepts, for any sane recording", () => {
    expect(planChunks(8 * 3600).length).toBeLessThanOrEqual(100);
  });
});

describe("stitching transcripts back together", () => {
  const first = {
    full_transcript: "hello from the first part",
    segments: [
      { segment_id: 0, start_time: 0, end_time: 2, text: "hello", speaker_id: 1 },
      { segment_id: 1, start_time: 2, end_time: 4, text: "from the first part" },
    ],
  };
  const second = {
    full_transcript: "and the second",
    segments: [
      { segment_id: 0, start_time: 0, end_time: 3, text: "and the second" },
    ],
  };

  it("joins the text in order", () => {
    expect(stitch([first, second], [0, 900]).transcript).toBe(
      "hello from the first part and the second",
    );
  });

  it("shifts later segments by where their slice starts", () => {
    const { segments } = stitch([first, second], [0, 900]);
    expect(segments.map((s) => s.start_time)).toEqual([0, 2, 900]);
    expect(segments.map((s) => s.end_time)).toEqual([2, 4, 903]);
  });

  it("renumbers segments continuously across slices", () => {
    const { segments } = stitch([first, second], [0, 900]);
    expect(segments.map((s) => s.segment_id)).toEqual([0, 1, 2]);
  });

  it("preserves speaker labels through the shift", () => {
    expect(stitch([first], [0]).segments[0].speaker_id).toBe(1);
  });

  it("handles a single slice as an identity operation", () => {
    const { segments, transcript } = stitch([first], [0]);
    expect(transcript).toBe("hello from the first part");
    expect(segments.map((s) => s.start_time)).toEqual([0, 2]);
  });

  it("skips empty slices without breaking later offsets", () => {
    const { transcript, segments } = stitch(
      [first, { full_transcript: "  ", segments: [] }, second],
      [0, 900, 1800],
    );
    expect(transcript).toBe("hello from the first part and the second");
    expect(segments[segments.length - 1].start_time).toBe(1800);
  });

  it("tolerates a slice that returned no segments at all", () => {
    const { segments } = stitch(
      [{ full_transcript: "text only" }, second],
      [0, 60],
    );
    expect(segments).toHaveLength(1);
    expect(segments[0].start_time).toBe(60);
  });
});
