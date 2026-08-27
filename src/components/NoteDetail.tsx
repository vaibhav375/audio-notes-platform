"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import Markdown from "react-markdown";
import type { NoteView } from "@/lib/serialize";
import {
  completionRatio,
  formatBytes,
  formatDuration,
  isActive,
  statusDetail,
  statusLabel,
} from "@/lib/status";
import { NoteStrip } from "@/components/TickStrip";
import { StatusChip } from "@/components/StatusChip";
import { TranscriptPlayer } from "@/components/TranscriptPlayer";
import { ExportMenu } from "@/components/ExportMenu";

const STAGES = [
  { key: "upload", label: "Uploaded" },
  { key: "transcribe", label: "Transcribed" },
  { key: "summarise", label: "Summarised" },
] as const;

export function NoteDetail({ initial }: { initial: NoteView }) {
  const [note, setNote] = useState<NoteView>(initial);
  const [pollError, setPollError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const poll = useCallback(async (id: string) => {
    const response = await fetch(`/api/notes/${id}`, { cache: "no-store" });
    const payload = (await response.json()) as { note?: NoteView; error?: string };
    if (!response.ok || !payload.note) {
      throw new Error(payload.error ?? `HTTP ${response.status}`);
    }
    return payload.note;
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!isActive(note.status)) return;

    const tick = async () => {
      try {
        const next = await poll(initial.id);
        if (cancelled) return;
        setNote(next);
        setPollError(null);
        if (isActive(next.status)) timer.current = setTimeout(tick, 4000);
      } catch (error) {
        if (cancelled) return;
        setPollError(
          error instanceof Error
            ? error.message
            : "Lost contact with the server while checking progress.",
        );
        // Back off rather than hammering a server that is already unhappy.
        timer.current = setTimeout(tick, 10_000);
      }
    };

    timer.current = setTimeout(tick, 2500);
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [initial.id, note.status, poll]);

  const retry = useCallback(async () => {
    setRetrying(true);
    setPollError(null);
    try {
      const response = await fetch(`/api/notes/${note.id}/retry`, { method: "POST" });
      const payload = (await response.json()) as { note?: NoteView; error?: string };
      if (!response.ok || !payload.note) {
        throw new Error(payload.error ?? `HTTP ${response.status}`);
      }
      setNote(payload.note);
    } catch (error) {
      setPollError(error instanceof Error ? error.message : "Retry failed.");
    } finally {
      setRetrying(false);
    }
  }, [note.id]);

  const reached = stageIndex(note);

  return (
    <article className="detail">
      <Link href="/" className="detail__back">
        ← Library
      </Link>

      <header className="detail__head card">
        <div className="detail__headTop">
          <div>
            <p className="eyebrow">Recording</p>
            <h1 className="detail__title">{note.originalFilename}</h1>
          </div>
          <StatusChip note={note} />
        </div>

        <NoteStrip note={note} ratio={completionRatio(note)} />

        <dl className="readout">
          <Readout label="Length" value={formatDuration(note.durationSeconds)} />
          <Readout label="Language" value={note.languageCode} />
          <Readout
            label="Sent"
            value={`${formatBytes(note.uploadedBytes)}${note.transcoded ? " · re-encoded" : ""}`}
          />
          <Readout
            label="Speakers"
            value={note.diarize ? "separated" : "not separated"}
          />
        </dl>

        <ol className="stages" aria-label="Processing stages">
          {STAGES.map((stage, index) => {
            const state =
              note.status === "failed" && index === reached
                ? "failed"
                : index < reached
                  ? "done"
                  : index === reached
                    ? "live"
                    : "todo";
            return (
              <li key={stage.key} className={`stages__item stages__item--${state}`}>
                <span className="stages__mark" aria-hidden="true" />
                <span className="stages__label">{stage.label}</span>
              </li>
            );
          })}
        </ol>

        {statusDetail(note) ? (
          <p className="detail__status">{statusDetail(note)}</p>
        ) : null}

        {note.slow && note.status !== "failed" ? (
          <div className="notice notice--warn" role="status">
            <span className="notice__title">This is taking longer than usual</span>
            <span>
              {statusLabel(note)} has been running for several minutes. The job is
              still live and will finish on its own, or fail with a reason — nothing
              is lost either way.
            </span>
          </div>
        ) : null}

        {note.status === "failed" ? (
          <div className="notice notice--error" role="alert">
            <span className="notice__title">
              {note.failureStage === "summary"
                ? "The summary failed"
                : "Transcription failed"}
            </span>
            <span>{note.errorMessage ?? "No further detail was reported."}</span>
            {note.failureStage === "summary" && note.transcript ? (
              <span className="notice__hint">
                The transcript below was saved and is unaffected.
              </span>
            ) : null}
            <span>
              <button className="btn btn--small" onClick={() => void retry()} disabled={retrying}>
                {retrying
                  ? "Retrying…"
                  : note.failureStage === "summary"
                    ? "Retry the summary"
                    : "Retry transcription"}
              </button>
            </span>
          </div>
        ) : null}

        {pollError ? (
          <div className="notice notice--warn" role="status">
            <span className="notice__title">Progress updates paused</span>
            <span>{pollError}</span>
            <span className="notice__hint">
              Retrying automatically. Processing continues on the server regardless.
            </span>
          </div>
        ) : null}

      </header>

      <section className="panel card" aria-labelledby="summary-heading">
        <div className="panel__head">
          <h2 id="summary-heading" className="panel__title panel__title--bare">
            Summary
          </h2>
          {note.transcript ? <ExportMenu note={note} /> : null}
        </div>
        {note.summary ? (
          <div className="prose">
            <Markdown>{note.summary}</Markdown>
          </div>
        ) : (
          <p className="panel__placeholder">
            {note.status === "failed"
              ? "No summary was produced for this recording."
              : "The summary appears here once the transcript is ready."}
          </p>
        )}
      </section>

      <section className="panel card" aria-labelledby="transcript-heading">
        <h2 id="transcript-heading" className="panel__title">
          Transcript
        </h2>
        {note.transcript ? (
          <TranscriptPlayer
            audioUrl={note.audioUrl}
            segments={note.segments}
            transcript={note.transcript}
            diarize={note.diarize}
          />
        ) : (
          <p className="panel__placeholder">
            {note.status === "failed"
              ? "No transcript was produced for this recording."
              : "Gnani is still working through the audio."}
          </p>
        )}
      </section>
    </article>
  );
}

function Readout({
  label,
  value,
  truncate,
}: {
  label: string;
  value: string;
  truncate?: boolean;
}) {
  return (
    <div className="readout__item">
      <dt>{label}</dt>
      <dd className={truncate ? "readout__value readout__value--truncate" : "readout__value"}>
        {value}
      </dd>
    </div>
  );
}

/** Which stage the note is currently sitting at. */
function stageIndex(note: NoteView): number {
  switch (note.status) {
    case "uploaded":
      return 1;
    case "transcribing":
      return 1;
    case "summarizing":
      return 2;
    case "completed":
      return 3;
    case "failed":
      return note.failureStage === "summary" ? 2 : 1;
  }
}
