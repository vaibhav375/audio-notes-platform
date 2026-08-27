import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

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
      ts_rank(${DOCUMENT}, ${q}) AS rank
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
  }));
}
