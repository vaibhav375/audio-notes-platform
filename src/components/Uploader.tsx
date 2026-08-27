"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import {
  AudioPrepareError,
  MAX_INPUT_BYTES,
  formatMb,
  prepareAudio,
  type PrepareStage,
} from "@/lib/audio/prepare";
import { SUPPORTED_LANGUAGES } from "@/lib/constants";
import { TickStrip } from "@/components/TickStrip";

type Phase = "idle" | "preparing" | "uploading" | "registering";

type Failure = { title: string; detail: string; hint: string | null };

const STAGE_COPY: Record<PrepareStage, string> = {
  reading: "Reading the file",
  decoding: "Decoding the audio",
  encoding: "Re-encoding to fit the 10 MB transcription limit",
  done: "Ready to upload",
};

export function Uploader({ onStarted }: { onStarted: () => void }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  const [phase, setPhase] = useState<Phase>("idle");
  const [stage, setStage] = useState<PrepareStage>("reading");
  const [ratio, setRatio] = useState(0);
  const [detail, setDetail] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [language, setLanguage] = useState<string>("en-IN");
  const [diarize, setDiarize] = useState(false);
  const [dragging, setDragging] = useState(false);

  const busy = phase !== "idle";

  const handleFile = useCallback(
    async (file: File) => {
      setFailure(null);
      setRatio(0);
      setDetail(null);

      try {
        // 1. Decode, validate and (when needed) re-encode entirely in the browser.
        setPhase("preparing");
        const prepared = await prepareAudio(file, ({ stage: s, ratio: r }) => {
          setStage(s);
          setRatio(r ?? 0);
        });

        setDetail(
          prepared.transcoded
            ? `Re-encoded ${formatMb(prepared.originalBytes)} to ${formatMb(prepared.blob.size)} mono MP3`
            : `Uploading ${formatMb(prepared.blob.size)} unchanged`,
        );

        // 2. Upload straight to blob storage, bypassing the API request size cap.
        setPhase("uploading");
        setRatio(0);
        const blob = await upload(prepared.filename, prepared.blob, {
          access: "public",
          handleUploadUrl: "/api/blob/upload",
          contentType: prepared.contentType,
          onUploadProgress: ({ percentage }) => setRatio(percentage / 100),
        });

        // 3. Register the note; the server creates and starts the Gnani job
        //    inside this request, so a rejection surfaces immediately.
        setPhase("registering");
        setRatio(1);

        const response = await fetch("/api/notes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            audioUrl: blob.url,
            audioPathname: blob.pathname,
            originalFilename: file.name,
            originalBytes: file.size,
            uploadedBytes: prepared.blob.size,
            contentType: prepared.contentType,
            transcoded: prepared.transcoded,
            durationSeconds: prepared.durationSeconds,
            languageCode: language,
            diarize,
          }),
        });

        const payload = (await response.json()) as {
          note?: { id: string };
          error?: string;
        };

        if (!response.ok || !payload.note) {
          throw new Error(payload.error ?? `The server rejected the upload (HTTP ${response.status}).`);
        }

        onStarted();
        router.push(`/notes/${payload.note.id}`);
      } catch (error) {
        setPhase("idle");
        setRatio(0);
        if (error instanceof AudioPrepareError) {
          setFailure({
            title: "That file could not be used",
            detail: error.message,
            hint: error.hint,
          });
        } else {
          setFailure({
            title: "Upload failed",
            detail:
              error instanceof Error
                ? error.message
                : "Something went wrong while uploading.",
            hint: "Nothing was saved. Check your connection and try again.",
          });
        }
        return;
      }

      setPhase("idle");
    },
    [diarize, language, onStarted, router],
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setDragging(false);
      if (busy) return;
      const file = event.dataTransfer.files?.[0];
      if (file) void handleFile(file);
    },
    [busy, handleFile],
  );

  return (
    <section className="uploader card" aria-labelledby="uploader-heading">
      <div className="uploader__head">
        <div>
          <p className="eyebrow">New recording</p>
          <h1 id="uploader-heading" className="uploader__title">
            Drop a recording in.
            <br />
            Get it back as words.
          </h1>
          <p className="uploader__lede">
            Two minutes or two hours. The file is decoded and compressed in your
            browser before it leaves, transcribed by Gnani&apos;s speech-to-text
            API, then summarised.
          </p>
        </div>

        <div className="controls">
          <label className="field">
            <span className="field__label">Spoken language</span>
            <select
              className="field__select"
              value={language}
              disabled={busy}
              onChange={(event) => setLanguage(event.target.value)}
            >
              {SUPPORTED_LANGUAGES.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="toggle">
            <input
              type="checkbox"
              checked={diarize}
              disabled={busy}
              onChange={(event) => setDiarize(event.target.checked)}
            />
            <span>
              <span className="toggle__label">Two-speaker call</span>
              <span className="toggle__hint">
                Label who said what. For interviews and support calls.
              </span>
            </span>
          </label>
        </div>
      </div>

      <div
        className={`dropzone${dragging ? " dropzone--over" : ""}${busy ? " dropzone--busy" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          if (!busy) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        {busy ? (
          <div className="dropzone__working">
            <TickStrip
              ratio={phase === "preparing" ? ratio * 0.55 : 0.55 + ratio * 0.45}
              tone="live"
              ticks={64}
              label="Upload progress"
            />
            <p className="dropzone__stage">
              {phase === "preparing"
                ? STAGE_COPY[stage]
                : phase === "uploading"
                  ? `Uploading — ${Math.round(ratio * 100)}%`
                  : "Handing the recording to Gnani"}
            </p>
            {detail ? <p className="meta">{detail}</p> : null}
          </div>
        ) : (
          <>
            <p className="dropzone__prompt">Drag an audio file here</p>
            <button
              type="button"
              className="btn"
              onClick={() => inputRef.current?.click()}
            >
              Choose a file
            </button>
            <p className="meta dropzone__formats">
              MP3 · WAV · M4A · AAC · FLAC · OGG · WebM — up to{" "}
              {formatMb(MAX_INPUT_BYTES)}
            </p>
          </>
        )}

        <input
          ref={inputRef}
          type="file"
          accept="audio/*,video/mp4,video/webm,.m4a,.aac,.opus,.amr"
          className="dropzone__input"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void handleFile(file);
          }}
        />
      </div>

      {failure ? (
        <div className="notice notice--error" role="alert">
          <span className="notice__title">{failure.title}</span>
          <span>{failure.detail}</span>
          {failure.hint ? <span className="notice__hint">{failure.hint}</span> : null}
        </div>
      ) : null}
    </section>
  );
}
