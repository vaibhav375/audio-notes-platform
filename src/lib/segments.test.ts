import { describe, expect, it } from "vitest";
import { normaliseSegments } from "@/lib/pipeline";

describe("segment normalisation", () => {
  it("keeps only the fields the app uses", () => {
    const result = normaliseSegments([
      {
        segment_id: 0,
        start_time: 0,
        end_time: 1.2,
        text: "hello",
        speaker_id: 1,
        confidence: null,
        sentiment: null,
        emotion: null,
        language_detected: null,
      },
    ]);
    expect(result).toEqual([
      { segment_id: 0, start_time: 0, end_time: 1.2, text: "hello", speaker_id: 1 },
    ]);
  });

  it("drops entries with no usable text", () => {
    expect(
      normaliseSegments([
        { segment_id: 0, start_time: 0, end_time: 1, text: "   " },
        { segment_id: 1, start_time: 1, end_time: 2, text: "kept" },
      ]),
    ).toHaveLength(1);
  });

  it("drops entries with no usable start time", () => {
    expect(
      normaliseSegments([{ segment_id: 0, start_time: "nope", text: "x" }]),
    ).toBeNull();
  });

  it("coerces numeric strings, which some endpoints return", () => {
    const [segment] = normaliseSegments([
      { segment_id: "3", start_time: "1.50", end_time: "2.25", text: "x" },
    ])!;
    expect(segment.start_time).toBe(1.5);
    expect(segment.end_time).toBe(2.25);
    expect(segment.segment_id).toBe(3);
  });

  it("records a missing speaker as null rather than NaN", () => {
    const [segment] = normaliseSegments([
      { segment_id: 0, start_time: 0, end_time: 1, text: "x", speaker_id: null },
    ])!;
    expect(segment.speaker_id).toBeNull();
  });

  it("falls back to the array index when no id is supplied", () => {
    const result = normaliseSegments([
      { start_time: 0, end_time: 1, text: "a" },
      { start_time: 1, end_time: 2, text: "b" },
    ])!;
    expect(result.map((s) => s.segment_id)).toEqual([0, 1]);
  });

  it("returns null for anything that is not a populated array", () => {
    expect(normaliseSegments(null)).toBeNull();
    expect(normaliseSegments([])).toBeNull();
    expect(normaliseSegments("nope")).toBeNull();
  });
});
