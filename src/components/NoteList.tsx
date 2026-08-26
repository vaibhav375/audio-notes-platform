"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { NoteView } from "@/lib/serialize";
import {
  completionRatio,
  formatDuration,
  formatWhen,
  isActive,
} from "@/lib/status";
import { NoteStrip } from "@/components/TickStrip";
import { StatusChip } from "@/components/StatusChip";

/**
 * The library of past uploads.
 *
 * Polls only while something is genuinely in flight, and stops once every note
 * has reached a terminal state — a static list has nothing to refresh.
 */
export function NoteList({ refreshToken }: { refreshToken: number }) {
  const [notes, setNotes] = useState<NoteView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/notes", { cache: "no-store" });
      const payload = (await response.json()) as {
        notes?: NoteView[];
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
      setNotes(payload.notes ?? []);
      setError(null);
      return payload.notes ?? [];
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not reach the server to load past uploads.",
      );
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      const result = await load();
      if (cancelled) return;
      const active = result?.some((note) => isActive(note.status)) ?? false;
      timer.current = setTimeout(tick, active ? 4000 : 30_000);
    };

    void tick();

    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load, refreshToken]);

  return (
    <section className="library" aria-labelledby="library-heading">
      <div className="library__head">
        <h2 id="library-heading" className="library__title">
          Library
        </h2>
        <p className="meta">
          {notes ? `${notes.length} recording${notes.length === 1 ? "" : "s"}` : "Loading"}
        </p>
      </div>

      {error ? (
        <div className="notice notice--error" role="alert">
          <span className="notice__title">Could not load your library</span>
          <span>{error}</span>
          <span className="notice__hint">
            <button className="btn btn--ghost btn--small" onClick={() => void load()}>
              Try again
            </button>
          </span>
        </div>
      ) : null}

      {notes && notes.length === 0 && !error ? (
        <div className="empty card">
          <p className="empty__title">Nothing here yet</p>
          <p className="empty__body">
            Upload a recording above and it will show up here, along with everything
            you upload later.
          </p>
        </div>
      ) : null}

      {notes && notes.length > 0 ? (
        <ul className="rows">
          {notes.map((note) => (
            <li key={note.id}>
              <Link href={`/notes/${note.id}`} className="row card">
                <div className="row__main">
                  <span className="row__name">{note.originalFilename}</span>
                  <span className="meta row__meta">
                    {formatDuration(note.durationSeconds)} ·{" "}
                    {note.languageCode} · {formatWhen(note.createdAt)}
                  </span>
                </div>
                <div className="row__strip">
                  <NoteStrip note={note} ratio={completionRatio(note)} />
                </div>
                <StatusChip note={note} />
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
