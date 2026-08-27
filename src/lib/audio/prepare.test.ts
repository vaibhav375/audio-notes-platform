import { describe, expect, it } from "vitest";
import { CHUNK_SECONDS, chooseBitrate } from "@/lib/audio/prepare";
import { GNANI_MAX_FILE_BYTES } from "@/lib/constants";

/** Bytes an MP3 of this length occupies at this bitrate. */
function encodedBytes(seconds: number, kbps: number): number {
  return (seconds * kbps * 1000) / 8;
}

describe("bitrate selection", () => {
  it("keeps short recordings at full quality", () => {
    expect(chooseBitrate(60)).toBe(64);
    expect(chooseBitrate(600)).toBe(64);
  });

  it("never drops below the floor, however long the recording", () => {
    expect(chooseBitrate(10 * 60 * 60)).toBe(24);
  });

  it("keeps every slice-length input inside the provider's per-file limit", () => {
    // This function only ever sees the length of a single slice, never a whole
    // recording. Anything up to the slice length must fit; the guarantee for
    // longer recordings is chunking's job and is asserted in chunking.test.ts.
    for (let seconds = 10; seconds <= CHUNK_SECONDS; seconds += 37) {
      const bytes = encodedBytes(seconds, chooseBitrate(seconds));
      expect(bytes).toBeLessThanOrEqual(GNANI_MAX_FILE_BYTES);
    }
  });

  it("cannot hold the limit on its own past roughly an hour", () => {
    // Documents why chunking exists: clamping at the floor bitrate stops
    // guaranteeing anything once the recording is long enough, so a single
    // file is the wrong unit for a long recording.
    const tooLong = 70 * 60;
    expect(chooseBitrate(tooLong)).toBe(24);
    expect(encodedBytes(tooLong, 24)).toBeGreaterThan(GNANI_MAX_FILE_BYTES);
  });

  it("fits the case the whole design exists for: a 2 minute stereo WAV", () => {
    // 2 min of 44.1 kHz 16-bit stereo is ~21 MB and cannot be uploaded as-is.
    const raw = 120 * 44100 * 2 * 2;
    expect(raw).toBeGreaterThan(GNANI_MAX_FILE_BYTES);
    expect(encodedBytes(120, chooseBitrate(120))).toBeLessThan(GNANI_MAX_FILE_BYTES);
  });

  it("holds full quality across the whole slice length", () => {
    expect(chooseBitrate(CHUNK_SECONDS)).toBe(64);
  });
});
