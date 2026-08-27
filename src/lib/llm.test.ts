import { describe, expect, it } from "vitest";
import { splitForPasses } from "@/lib/llm";

describe("splitting a transcript into summarisation passes", () => {
  it("leaves a short transcript in a single pass", () => {
    expect(splitForPasses("a few words here", 1000)).toEqual(["a few words here"]);
  });

  it("keeps every pass within the size budget", () => {
    const transcript = Array.from({ length: 4000 }, (_, i) => `word${i}`).join(" ");
    for (const pass of splitForPasses(transcript, 500)) {
      expect(pass.length).toBeLessThanOrEqual(500);
    }
  });

  it("loses no words, which is the whole point over truncating", () => {
    const words = Array.from({ length: 1500 }, (_, i) => `w${i}`);
    const passes = splitForPasses(words.join(" "), 300);
    expect(passes.join(" ").split(" ")).toEqual(words);
  });

  it("never splits a word across two passes", () => {
    const passes = splitForPasses(
      Array.from({ length: 500 }, () => "reconciliation").join(" "),
      200,
    );
    for (const pass of passes) {
      for (const word of pass.split(" ")) expect(word).toBe("reconciliation");
    }
  });

  it("handles a single word longer than the budget without looping forever", () => {
    const long = "x".repeat(900);
    expect(splitForPasses(long, 100)).toEqual([long]);
  });

  it("collapses irregular whitespace", () => {
    expect(splitForPasses("a  \n b \t c", 1000)).toEqual(["a b c"]);
  });

  it("produces the passes a long recording actually needs", () => {
    // ~36 minutes of speech is roughly 30k characters at conversational pace.
    expect(splitForPasses("word ".repeat(6000), 12_000).length).toBeGreaterThan(1);
  });
});
