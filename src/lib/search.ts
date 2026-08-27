import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import type { Segment } from "@/lib/db/schema";

/**
 * Full-text search across stored transcripts and summaries.
 *
 * Uses Postgres's `simple` text-search configuration rather than `english`:
 * this app transcribes nine Indian languages, and an English stemmer would
 * mangle Devanagari and every other non-Latin script. `simple` just lowercases
 * and splits on word boundaries, which works uniformly across all of them.
 */

export type SearchHit = {
  id: string;
  originalFilename: string;
  status: string;
  languageCode: string;
  durationSeconds: number | null;
  createdAt: string;
  /**
   * Matching excerpt. Terms are wrapped in the sentinels below rather than in
   * HTML: ts_headline does not escape the document it highlights, so emitting
   * markup here would let any transcript or summary inject into the page. The
   * client splits on these and builds real elements instead.
   */
  snippet: string;
  rank: number;
  /** Where in the recording the match was spoken, when it can be located. */
  atSeconds: number | null;
};

/** Deliberately not HTML. See SearchHit.snippet. */
export const HL_START = "\u0001HL\u0001";
export const HL_END = "\u0002HL\u0002";

const DOCUMENT = sql`
  to_tsvector('simple',
    coalesce(transcript, '') || ' ' ||
    coalesce(summary, '') || ' ' ||
    original_filename)
`;

export async function searchNotes(query: string, limit = 25): Promise<SearchHit[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  // websearch_to_tsquery accepts what people actually type — quoted phrases,
  // OR, and leading minus — without throwing on malformed input the way
  // to_tsquery does.
  const q = sql`websearch_to_tsquery('simple', ${trimmed})`;

  const rows = await db().execute<{
    id: string;
    original_filename: string;
    status: string;
    language_code: string;
    duration_seconds: number | null;
    created_at: string;
    snippet: string;
    rank: number;
    segments: Segment[] | null;
  }>(sql`
    SELECT
      id,
      original_filename,
      status,
      language_code,
      duration_seconds,
      created_at,
      ts_headline('simple',
        coalesce(transcript, coalesce(summary, '')),
        ${q},
        ${`StartSel=${HL_START}, StopSel=${HL_END}, MaxWords=34, MinWords=14, MaxFragments=2, FragmentDelimiter=" … "`}
      ) AS snippet,
      ts_rank(${DOCUMENT}, ${q}) AS rank,
      segments
    FROM notes
    WHERE ${DOCUMENT} @@ ${q}
    ORDER BY rank DESC, created_at DESC
    LIMIT ${limit}
  `);

  return (rows.rows ?? []).map((row) => ({
    id: row.id,
    originalFilename: row.original_filename,
    status: row.status,
    languageCode: row.language_code,
    durationSeconds: row.duration_seconds,
    createdAt: new Date(row.created_at).toISOString(),
    snippet: row.snippet ?? "",
    rank: Number(row.rank ?? 0),
    atSeconds: locateMatch(row.segments, trimmed),
  }));
}

/**
 * Finds where a match was spoken.
 *
 * Postgres ranks the recording; the timings are what make a hit useful, so the
 * first segment containing any search term becomes the deep link target. Doing
 * this here rather than in SQL keeps the query one index scan.
 */
export function locateMatch(
  segments: Segment[] | null | undefined,
  query: string,
): number | null {
  if (!segments?.length) return null;

  const terms = query
    .toLowerCase()
    .replace(/["']/g, " ")
    .split(/\s+/)
    .filter((term) => term.length > 1 && !["or", "and", "not"].includes(term))
    .map((term) => (term.startsWith("-") ? term.slice(1) : term))
    .filter(Boolean);

  if (terms.length === 0) return null;

  for (const segment of segments) {
    const text = segment.text.toLowerCase();
    if (terms.some((term) => text.includes(term))) {
      return Math.max(0, Math.floor(segment.start_time));
    }
  }
  return null;
}

/** One run of text from a search excerpt; `marked` runs are the query matches. */
export type SnippetPart = { text: string; marked: boolean };

/**
 * Splits a sentinel-wrapped excerpt into plain runs. Kept out of the component
 * so it can be tested directly, and so nothing is ever handed to the DOM as
 * HTML.
 */
export function splitSnippet(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  for (const [index, chunk] of snippet.split(HL_START).entries()) {
    if (index === 0) {
      if (chunk) parts.push({ text: chunk, marked: false });
      continue;
    }
    const end = chunk.indexOf(HL_END);
    if (end === -1) {
      if (chunk) parts.push({ text: chunk, marked: false });
      continue;
    }
    const marked = chunk.slice(0, end);
    const rest = chunk.slice(end + HL_END.length);
    if (marked) parts.push({ text: marked, marked: true });
    if (rest) parts.push({ text: rest, marked: false });
  }
  return parts;
}
