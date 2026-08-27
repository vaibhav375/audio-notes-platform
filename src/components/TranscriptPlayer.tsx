"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Segment } from "@/lib/db/schema";

/**
 * A transcript you can navigate rather than just read.
 *
 * The provider returns per-utterance timings, so every line is a seek target
 * and the line currently being spoken is highlighted as the audio plays. This
 * is what makes reopening a past recording useful — you can verify a claim
 * against the audio instead of taking the transcript's word for it.
 */
export function TranscriptPlayer({
  audioUrl,
  segments,
  transcript,
  diarize,
}: {
  audioUrl: string;
  segments: Segment[] | null;
  transcript: string | null;
  diarize: boolean;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [follow, setFollow] = useState(true);

  const hasSegments = !!segments?.length;

  // Track which segment is playing. `timeupdate` fires ~4x a second, which is
  // ample for line-level highlighting and far cheaper than an animation frame.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !segments?.length) return;

    const onTime = () => {
      const t = audio.currentTime;
      const index = segments.findIndex(
        (segment, i) =>
          t >= segment.start_time &&
          (t < segment.end_time || i === segments.length - 1),
      );
      setActiveIndex(index);
    };

    audio.addEventListener("timeupdate", onTime);
    return () => audio.removeEventListener("timeupdate", onTime);
  }, [segments]);

  // Keep the playing line in view, unless the reader has scrolled away to read
  // somewhere else — following them around would be hostile.
  useEffect(() => {
    if (!follow || activeIndex < 0 || !listRef.current) return;
    const el = listRef.current.children[activeIndex] as HTMLElement | undefined;
    if (!el) return;
    const list = listRef.current;
    const above = el.offsetTop < list.scrollTop;
    const below = el.offsetTop + el.offsetHeight > list.scrollTop + list.clientHeight;
    if (above || below) {
      list.scrollTo({ top: el.offsetTop - list.clientHeight / 2.5, behavior: "smooth" });
    }
  }, [activeIndex, follow]);

  const seek = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = seconds;
    setFollow(true);
    void audio.play().catch(() => {
      // Autoplay can be blocked; the seek still lands, which is the point.
    });
  }, []);

  return (
    <>
      <audio
        ref={audioRef}
        className="detail__audio"
        controls
        preload="metadata"
        src={audioUrl}
      >
        Your browser cannot play this audio file.
      </audio>

      {hasSegments ? (
        <>
          <p className="transcript__hint meta">
            {segments!.length} segments · select any line to play from there
          </p>
          <ol
            className="segments"
            ref={listRef}
            onScroll={() => setFollow(false)}
          >
            {segments!.map((segment, index) => (
              <li
                key={segment.segment_id}
                className={`segment${index === activeIndex ? " segment--active" : ""}`}
              >
                <button
                  type="button"
                  className="segment__button"
                  onClick={() => seek(segment.start_time)}
                >
                  <span className="segment__time">{clock(segment.start_time)}</span>
                  {diarize && segment.speaker_id != null ? (
                    <span className={`segment__speaker segment__speaker--${segment.speaker_id}`}>
                      S{segment.speaker_id}
                    </span>
                  ) : null}
                  <span className="segment__text">{segment.text}</span>
                </button>
              </li>
            ))}
          </ol>
        </>
      ) : (
        <p className="transcript">{transcript}</p>
      )}
    </>
  );
}

function clock(seconds: number): string {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, "0");
  return h > 0
    ? `${h}:${mm}:${String(s).padStart(2, "0")}`
    : `${mm}:${String(s).padStart(2, "0")}`;
}
