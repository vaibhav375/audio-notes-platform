import { describe, expect, it } from "vitest";
import { orderFiles } from "@/lib/pipeline";
import type { AudioPart, Note } from "@/lib/db/schema";

const HOST = "https://store.public.blob.vercel-storage.com";

function part(index: number): AudioPart {
  return {
    url: `${HOST}/rec-part0${index + 1}-r4nd0m.mp3`,
    pathname: `rec-part0${index + 1}-r4nd0m.mp3`,
    bytes: 1000,
    offsetSeconds: index * 25,
    durationSeconds: 25,
  };
}

function note(count: number): Note {
  return {
    parts: Array.from({ length: count }, (_, i) => part(i)),
  } as Note;
}

function file(path: string) {
  return { file_id: path, status: "COMPLETED", original_path: path };
}

describe("putting provider files back into recording order", () => {
  it("orders cloud-storage files, which echo the full URL", () => {
    // The API returned a five file job as 5, 1, 3, 2, 4.
    const shuffled = [4, 0, 2, 1, 3].map((i) => file(part(i).url));
    const ordered = orderFiles(shuffled, note(5));
    expect(ordered.map((f) => f.original_path)).toEqual(
      [0, 1, 2, 3, 4].map((i) => part(i).url),
    );
  });

  it("orders uploaded files, which echo only the filename", () => {
    const shuffled = [2, 0, 1].map((i) => file(part(i).pathname));
    const ordered = orderFiles(shuffled, note(3));
    expect(ordered.map((f) => f.original_path)).toEqual([
      part(0).pathname,
      part(1).pathname,
      part(2).pathname,
    ]);
  });

  it("leaves a single file alone", () => {
    const one = [file(part(0).url)];
    expect(orderFiles(one, note(1))).toEqual(one);
  });

  it("passes files through when the note predates chunking", () => {
    const files = [file("a.mp3"), file("b.mp3")];
    expect(orderFiles(files, { parts: null } as Note)).toEqual(files);
  });

  it("puts unrecognised files last rather than dropping them", () => {
    const files = [file("mystery.mp3"), file(part(0).url)];
    const ordered = orderFiles(files, note(2));
    expect(ordered[0].original_path).toBe(part(0).url);
    expect(ordered).toHaveLength(2);
  });
});
