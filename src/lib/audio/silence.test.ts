import { describe, expect, it } from "vitest";
import { leadingSilenceSamples } from "@/lib/audio/prepare";

const RATE = 16_000;

function build(silenceSeconds: number, toneSeconds: number): Float32Array {
  const samples = new Float32Array(
    Math.round((silenceSeconds + toneSeconds) * RATE),
  );
  const from = Math.round(silenceSeconds * RATE);
  for (let i = from; i < samples.length; i += 1) {
    samples[i] = Math.sin((i / RATE) * 2 * Math.PI * 220) * 0.5;
  }
  return samples;
}

describe("leading silence detection", () => {
  it("finds nothing to skip when a slice opens on speech", () => {
    expect(leadingSilenceSamples(build(0, 5), RATE)).toBe(0);
  });

  it("skips a leading pause, which is what makes a slice transcribe at all", () => {
    const trimmed = leadingSilenceSamples(build(1.33, 5), RATE);
    expect(trimmed / RATE).toBeGreaterThan(1.1);
    expect(trimmed / RATE).toBeLessThan(1.34);
  });

  it("keeps a short lead-in so the first word is not clipped", () => {
    // Never trims right up to the onset.
    expect(leadingSilenceSamples(build(2, 5), RATE) / RATE).toBeLessThan(2);
  });

  it("leaves a genuinely quiet slice alone", () => {
    expect(leadingSilenceSamples(new Float32Array(RATE * 5), RATE)).toBe(0);
  });

  it("gives up rather than skipping past a long quiet opening", () => {
    // Silence longer than the search window: do not run past it.
    expect(leadingSilenceSamples(build(6, 2), RATE, { maxTrimSeconds: 4 })).toBe(0);
  });

  it("ignores low-level noise that is not speech", () => {
    const samples = build(2, 3);
    for (let i = 0; i < RATE * 2; i += 1) samples[i] = 0.005;
    expect(leadingSilenceSamples(samples, RATE) / RATE).toBeGreaterThan(1.8);
  });
});
