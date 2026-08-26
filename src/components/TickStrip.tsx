import { statusTone } from "@/lib/status";
import type { NoteView } from "@/lib/serialize";

/**
 * The recurring motif: a recording rendered as a run of ticks.
 *
 * The number of ticks is fixed for layout stability; the filled run is the real
 * completion ratio, and the leading tick turns lime only while work is actually
 * in flight.
 */
export function TickStrip({
  ratio,
  tone,
  ticks = 48,
  label,
}: {
  ratio: number;
  tone: "idle" | "live" | "done" | "failed";
  ticks?: number;
  label?: string;
}) {
  const filled = Math.max(0, Math.min(ticks, Math.round(ratio * ticks)));

  return (
    <div
      className={`strip strip--${tone}`}
      role="progressbar"
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label ?? "Processing progress"}
    >
      {Array.from({ length: ticks }).map((_, i) => {
        const on = i < filled;
        const head = tone === "live" && i === filled - 1;
        return (
          <span
            key={i}
            className={[
              "strip__tick",
              on ? "strip__tick--on" : "",
              head ? "strip__tick--head" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={{ height: `${tickHeight(i, ticks)}%` }}
          />
        );
      })}
    </div>
  );
}

export function NoteStrip({ note, ratio }: { note: NoteView; ratio: number }) {
  return (
    <TickStrip
      ratio={ratio}
      tone={statusTone(note.status)}
      label={`Progress for ${note.originalFilename}`}
    />
  );
}

/**
 * A deterministic height pattern, so the strip reads as a signal rather than a
 * plain bar without pretending to be a waveform of audio nobody has analysed.
 */
function tickHeight(index: number, total: number): number {
  const wave = Math.sin((index / total) * Math.PI * 6);
  const secondary = Math.sin((index / total) * Math.PI * 13.7);
  return 42 + Math.abs(wave) * 34 + Math.abs(secondary) * 20;
}
