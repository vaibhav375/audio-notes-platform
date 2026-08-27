"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { splitSnippet, type SearchHit } from "@/lib/search";
import { formatDuration, formatWhen } from "@/lib/status";

/**
 * Search across every stored transcript and summary.
 *
 * The point of keeping transcripts is being able to answer "which recording
 * mentioned this?" months later, and a list ordered by date cannot do that.
 */
/**
 * Renders a search excerpt. Nothing is ever treated as HTML, so a transcript
 * containing markup renders as the text it is.
 */
function highlight(snippet: string): React.ReactNode[] {
  return splitSnippet(snippet).map((part, index) =>
    part.marked ? <mark key={index}>{part.text}</mark> : part.text,
  );
}

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function SearchBar() {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = useCallback(async (q: string) => {
    if (!q.trim()) {
      setHits(null);
      setError(null);
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
        cache: "no-store",
      });
      const payload = (await response.json()) as {
        hits?: SearchHit[];
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
      setHits(payload.hits ?? []);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That search failed.");
      setHits(null);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void run(query), 300);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [query, run]);

  return (
    <div className="search">
      <div className="search__field">
        <input
          type="search"
          className="search__input"
          placeholder="Search everything you've transcribed"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search transcripts and summaries"
        />
        {busy ? <span className="search__status meta">searching</span> : null}
        {query && !busy && hits ? (
          <span className="search__status meta">
            {hits.length} match{hits.length === 1 ? "" : "es"}
          </span>
        ) : null}
      </div>

      {error ? (
        <div className="notice notice--error" role="alert">
          <span className="notice__title">Search failed</span>
          <span>{error}</span>
        </div>
      ) : null}

      {hits && hits.length === 0 && query.trim() ? (
        <p className="search__empty meta">
          Nothing matches “{query.trim()}”. Search covers transcripts, summaries and
          filenames.
        </p>
      ) : null}

      {hits && hits.length > 0 ? (
        <ul className="hits">
          {hits.map((hit) => (
            <li key={hit.id}>
              <Link
                href={
                  hit.atSeconds != null
                    ? `/notes/${hit.id}?t=${hit.atSeconds}`
                    : `/notes/${hit.id}`
                }
                className="hit card"
              >
                <div className="hit__head">
                  <span className="hit__name">{hit.originalFilename}</span>
                  <span className="meta">
                    {hit.atSeconds != null ? (
                      <span className="hit__at">at {clock(hit.atSeconds)}</span>
                    ) : null}
                    {formatDuration(hit.durationSeconds)} · {hit.languageCode} ·{" "}
                    {formatWhen(hit.createdAt)}
                  </span>
                </div>
                <p className="hit__snippet">{highlight(hit.snippet)}</p>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
