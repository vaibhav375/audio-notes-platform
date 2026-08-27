import { describe, expect, it } from "vitest";
import { HL_END, HL_START, splitSnippet, toPrefixQuery } from "@/lib/search";

describe("search excerpt splitting", () => {
  it("marks the highlighted run and leaves the rest plain", () => {
    expect(splitSnippet(`a ${HL_START}match${HL_END} b`)).toEqual([
      { text: "a ", marked: false },
      { text: "match", marked: true },
      { text: " b", marked: false },
    ]);
  });

  it("handles several matches in one excerpt", () => {
    const parts = splitSnippet(
      `${HL_START}one${HL_END} and ${HL_START}two${HL_END}`,
    );
    expect(parts.filter((p) => p.marked).map((p) => p.text)).toEqual(["one", "two"]);
  });

  it("treats markup in the source as literal text, never as HTML", () => {
    const parts = splitSnippet(`<script>alert(1)</script> ${HL_START}hit${HL_END}`);
    expect(parts[0]).toEqual({ text: "<script>alert(1)</script> ", marked: false });
    // Nothing in the output is a tag; it is all plain runs for React to escape.
    expect(parts.every((p) => typeof p.text === "string")).toBe(true);
  });

  it("survives an unterminated sentinel without losing text", () => {
    const parts = splitSnippet(`before ${HL_START}dangling`);
    expect(parts.map((p) => p.text).join("")).toContain("dangling");
  });

  it("returns nothing for an empty excerpt", () => {
    expect(splitSnippet("")).toEqual([]);
  });
});

describe("building the search query", () => {
  it("matches the last term as a prefix, so partial words find whole ones", () => {
    expect(toPrefixQuery("refund")).toBe("refund:*");
  });

  it("requires every term, prefixing only the last", () => {
    expect(toPrefixQuery("duplicate charge")).toBe("duplicate & charge:*");
  });

  it("works on non-Latin scripts, which is where it matters most", () => {
    // A Kannada root rarely appears bare; searching it must still find the
    // inflected form in the transcript.
    expect(toPrefixQuery("ಶ್ರೀರಾಮಕೃಷ್ಣ")).toBe("ಶ್ರೀರಾಮಕೃಷ್ಣ:*");
    expect(toPrefixQuery("शेती")).toBe("शेती:*");
  });

  it("strips punctuation that would otherwise reach to_tsquery as syntax", () => {
    expect(toPrefixQuery("a & b")).toBe("a & b:*");
    expect(toPrefixQuery("!!! ???")).toBe("");
  });

  it("keeps digits, which appear in transcribed numbers", () => {
    expect(toPrefixQuery("10 megabytes")).toBe("10 & megabytes:*");
  });

  it("returns nothing for an empty query", () => {
    expect(toPrefixQuery("   ")).toBe("");
  });
});
