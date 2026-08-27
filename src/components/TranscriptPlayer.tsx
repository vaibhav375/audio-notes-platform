"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { AudioPart, Segment } from "@/lib/db/schema";

/**
 * A transcript you can navigate rather than just read.
 *
 * The provider returns per-utterance timings, so every line is a seek target
 * and the line currently being spoken is highlighted as the audio plays. This
 * is what makes reopening a past recording useful — you can verify a claim
 * against the audio instead of taking the transcript's word for it.
 */
export function TranscriptPlayer({
  noteId,
  audioUrl,
  parts,
  segments: initialSegments,
  transcript,
  diarize,
}: {
  noteId: string;
  audioUrl: string;
  parts: AudioPart[] | null;
  segments: Segment[] | null;
  transcript: string | null;
  diarize: boolean;
}) {
  const [segments, setSegments] = useState(initialSegments);
  const [relabelling, setRelabelling] = useState(false);
  const searchParams = useSearchParams();
  const audioRef = useRef<HTMLAudioElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [follow, setFollow] = useState(true);
  // A ref, not state: this is a handoff between "src changed" and "metadata
  // loaded", and putting it in state would re-render for no visual reason.
  const pendingPlay = useRef<number | null>(null);

  // A long recording is uploaded in slices, so the element plays one slice at a
  // time while the transcript addresses the whole thing. This maps between the
  // two, and collapses to a no-op for single-slice recordings.
  const slices: AudioPart[] = useMemo(() => {
    if (parts?.length) {
      return [...parts].sort((a, b) => a.offsetSeconds - b.offsetSeconds);
    }
    return [
      { url: audioUrl, pathname: "", bytes: 0, offsetSeconds: 0, durationSeconds: 0 },
    ];
  }, [parts, audioUrl]);

  const [sliceIndex, setSliceIndex] = useState(0);
  const currentSlice = slices[Math.min(sliceIndex, slices.length - 1)];

  const sliceFor = useCallback(
    (time: number) => {
      for (let i = slices.length - 1; i >= 0; i -= 1) {
        if (time >= slices[i].offsetSeconds) return i;
      }
      return 0;
    },
    [slices],
  );

  const hasSegments = !!segments?.length;

  // Track which segment is playing. `timeupdate` fires ~4x a second, which is
  // ample for line-level highlighting and far cheaper than an animation frame.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !segments?.length) return;

    const onTime = () => {
      const t = audio.currentTime + currentSlice.offsetSeconds;
      const index = segments.findIndex(
        (segment, i) =>
          t >= segment.start_time &&
          (t < segment.end_time || i === segments.length - 1),
      );
      setActiveIndex(index);
    };

    // Rolling from one slice into the next should feel like one recording.
    const onEnded = () => {
      if (sliceIndex < slices.length - 1) {
        pendingPlay.current = 0;
        setSliceIndex(sliceIndex + 1);
      }
    };

    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("ended", onEnded);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("ended", onEnded);
    };
  }, [segments, currentSlice.offsetSeconds, sliceIndex, slices.length]);

  // When the source changes, resume at the point that was asked for.
  useEffect(() => {
    const audio = audioRef.current;
    const target = pendingPlay.current;
    if (!audio || target == null) return;
    pendingPlay.current = null;

    const onReady = () => {
      audio.currentTime = target;
      void audio.play().catch(() => {
        // Autoplay may be blocked; the seek still lands, which is the point.
      });
    };
    if (audio.readyState >= 1) onReady();
    else audio.addEventListener("loadedmetadata", onReady, { once: true });

    return () => audio.removeEventListener("loadedmetadata", onReady);
  }, [sliceIndex]);

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

  const jumpedTo = useRef<string | null>(null);

  const seek = useCallback(
    (seconds: number) => {
      const audio = audioRef.current;
      if (!audio) return;
      setFollow(true);

      const target = sliceFor(seconds);
      const local = seconds - slices[target].offsetSeconds;

      if (target !== sliceIndex) {
        // Changing src; the effect above seeks once metadata has loaded.
        pendingPlay.current = local;
        setSliceIndex(target);
        return;
      }

      audio.currentTime = local;
      void audio.play().catch(() => {
        // Autoplay can be blocked; the seek still lands, which is the point.
      });
    },
    [sliceFor, sliceIndex, slices],
  );

  // Arriving from a search result: jump straight to where the match was said.
  // Deferred a tick so the audio element is mounted, and so this does not set
  // state synchronously inside the effect.
  useEffect(() => {
    const t = searchParams.get("t");
    if (!t || jumpedTo.current === t || !segments?.length) return;
    const seconds = Number(t);
    if (!Number.isFinite(seconds)) return;
    jumpedTo.current = t;
    const timer = setTimeout(() => seek(seconds), 0);
    return () => clearTimeout(timer);
  }, [searchParams, segments, seek]);

  /**
   * Reassigns a speaker from this point onwards.
   *
   * Diarization mislabels turns, and correcting one line at a time would be
   * tedious. A run of turns almost always shares the same mistake, so a change
   * carries forward until the next time the provider switched speaker.
   */
  const relabel = useCallback(
    async (index: number) => {
      if (!segments) return;
      const from = segments[index];
      const next = from.speaker_id === 1 ? 2 : 1;

      const updated = segments.map((segment, i) =>
        i >= index && segment.speaker_id === from.speaker_id
          ? { ...segment, speaker_id: next }
          : segment,
      );
      setSegments(updated);
      setRelabelling(true);

      try {
        await fetch(`/api/notes/${noteId}/speakers`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          // Addressed by position, not by segment_id: the provider returns the
          // same id for every segment, so ids are not identities here.
          body: JSON.stringify({ fromIndex: index, speakerId: next }),
        });
      } catch {
        setSegments(segments); // Put it back; the change did not stick.
      } finally {
        setRelabelling(false);
      }
    },
    [noteId, segments],
  );

  const audioAvailable = !!currentSlice.url;

  return (
    <>
      {audioAvailable ? (
      <audio
        ref={audioRef}
        className="detail__audio"
        controls
        preload="metadata"
        src={currentSlice.url}
      >
        Your browser cannot play this audio file.
      </audio>
      ) : (
        <p className="notice notice--warn" role="status">
          <span className="notice__title">Audio no longer stored</span>
          <span>
            This recording is past the retention window, so its audio has been
            deleted. The transcript and summary below are kept indefinitely.
          </span>
        </p>
      )}

      {slices.length > 1 ? (
        <p className="transcript__hint meta">
          Part {sliceIndex + 1} of {slices.length} · selecting a line moves
          between parts automatically
        </p>
      ) : null}

      {hasSegments ? (
        <>
          <p className="transcript__hint meta">
            {segments!.length} segments
            {audioAvailable ? " · select any line to play from there" : ""}
          </p>
          <ol
            className="segments"
            ref={listRef}
            onScroll={() => setFollow(false)}
          >
            {segments!.map((segment, index) => (
              <li
                key={index}
                className={`segment${index === activeIndex ? " segment--active" : ""}`}
              >
                <button
                  type="button"
                  className="segment__button"
                  disabled={!audioAvailable}
                  onClick={() => seek(segment.start_time)}
                >
                  <span className="segment__time">{clock(segment.start_time)}</span>
                  {diarize && segment.speaker_id != null ? (
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label={`Speaker ${segment.speaker_id}. Reassign from here.`}
                      title="Wrong speaker? Reassign from here onwards."
                      className={`segment__speaker segment__speaker--${segment.speaker_id}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (!relabelling) void relabel(index);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          event.stopPropagation();
                          if (!relabelling) void relabel(index);
                        }
                      }}
                    >
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
