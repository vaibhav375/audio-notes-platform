import { Mp3Encoder } from "@breezystack/lamejs";
import { GNANI_MAX_FILE_BYTES } from "@/lib/constants";

/**
 * Client-side preparation of an audio file before it is uploaded.
 *
 * Gnani's batch API accepts at most 10 MB per file. That is generous for
 * compressed audio but tiny for uncompressed: two minutes of 44.1 kHz stereo
 * WAV is already ~21 MB, so the assignment's "must handle 2+ minute files"
 * requirement cannot be met by passing user files straight through.
 *
 * Rather than transcode on the server — which would mean shipping an ffmpeg
 * binary into a serverless function and paying its cold start and CPU time on
 * every upload — the browser does it. Decoding also doubles as validation: a
 * file the Web Audio API cannot decode is corrupt or not audio, and that is
 * caught before a single byte is uploaded or a paid API call is made.
 */

/** Leave headroom under the hard cap for container overhead. */
const TARGET_MAX_BYTES = Math.floor(GNANI_MAX_FILE_BYTES * 0.9);

/** Speech recognition gains nothing above this; ASR models run at 16 kHz. */
const TARGET_SAMPLE_RATE = 16_000;

const MIN_BITRATE_KBPS = 24;
const MAX_BITRATE_KBPS = 64;

/**
 * Longest slice sent as a single file.
 *
 * Set by the synchronous endpoint's real limit. The documentation says audio
 * must be under sixty seconds; the API actually rejects anything over thirty
 * ("MAX_AUDIO_DURATION_EXCEEDED: maximum allowed duration of 30 seconds").
 * Twenty-five leaves margin for the small differences between a decoder's idea
 * of a file's length and the provider's.
 *
 * Slicing this finely serves both transcription paths: the batch API takes the
 * slices as one multi-file job, and the synchronous endpoint takes them one at
 * a time. Quality is never traded away for length either way — every slice is
 * encoded at the full 64 kbps regardless of how long the recording is.
 */
export const CHUNK_SECONDS = 25;

/** Guard against decoding something that will exhaust browser memory. */
export const MAX_INPUT_BYTES = 150 * 1024 * 1024;

/** The assignment targets 2+ minute recordings; this is the practical ceiling. */
export const MAX_DURATION_SECONDS = 90 * 60;

/** Most slices a single batch job accepts. Longer recordings use the sync path. */
export const MAX_BATCH_FILES = 100;

export class AudioPrepareError extends Error {
  readonly hint: string | null;

  constructor(message: string, hint: string | null = null) {
    super(message);
    this.name = "AudioPrepareError";
    this.hint = hint;
  }
}

export type PrepareStage = "reading" | "decoding" | "encoding" | "done";

export type PrepareProgress = {
  stage: PrepareStage;
  /** 0-1 within the current stage, or null when indeterminate. */
  ratio: number | null;
};

/** One uploadable slice of a recording. */
export type PreparedPart = {
  blob: Blob;
  filename: string;
  contentType: string;
  /** Where this slice starts within the whole recording. */
  offsetSeconds: number;
  durationSeconds: number;
};

export type PreparedAudio = {
  /** Ordered slices. A short recording produces exactly one. */
  parts: PreparedPart[];
  durationSeconds: number;
  transcoded: boolean;
  originalBytes: number;
};

/** Formats Gnani's batch API accepts directly. */
const PASSTHROUGH_TYPES = /^(audio\/(mpeg|mp3|mp4|m4a|x-m4a|aac|ogg|opus|flac|x-flac|webm)|video\/(mp4|webm))$/;

export async function prepareAudio(
  file: File,
  onProgress: (progress: PrepareProgress) => void,
): Promise<PreparedAudio> {
  if (file.size === 0) {
    throw new AudioPrepareError("That file is empty.");
  }

  if (file.size > MAX_INPUT_BYTES) {
    throw new AudioPrepareError(
      `That file is ${formatMb(file.size)}, larger than the ${formatMb(MAX_INPUT_BYTES)} this app will decode in the browser.`,
      "Export a compressed version of the recording and try again.",
    );
  }

  onProgress({ stage: "reading", ratio: null });
  const bytes = await file.arrayBuffer();

  onProgress({ stage: "decoding", ratio: null });
  const decoded = await decode(bytes);

  if (decoded.duration > MAX_DURATION_SECONDS) {
    throw new AudioPrepareError(
      `That recording is ${formatDuration(decoded.duration)} long, over this app's ${Math.round(MAX_DURATION_SECONDS / 60)}-minute limit.`,
      "Split the recording into shorter parts and upload them separately.",
    );
  }

  if (decoded.duration < 1) {
    throw new AudioPrepareError(
      "That recording is under a second long, so there is nothing to transcribe.",
    );
  }

  // A compressed file that already fits goes through untouched — re-encoding it
  // would only lose quality for no benefit.
  const alreadyFits =
    file.size <= TARGET_MAX_BYTES && PASSTHROUGH_TYPES.test(file.type);

  // Short enough to send whole, and already in a format the API takes.
  if (alreadyFits && decoded.duration <= CHUNK_SECONDS) {
    onProgress({ stage: "done", ratio: 1 });
    return {
      parts: [
        {
          blob: file,
          filename: file.name,
          contentType: file.type,
          offsetSeconds: 0,
          durationSeconds: decoded.duration,
        },
      ],
      durationSeconds: Math.round(decoded.duration),
      transcoded: false,
      originalBytes: file.size,
    };
  }

  const mono = downmixToMono(decoded);
  const sampleRate = decoded.sampleRate;
  const boundaries = planChunks(decoded.duration);
  const base = replaceExtension(file.name, "").replace(/\.$/, "") || "recording";

  const parts: PreparedPart[] = [];

  for (const [index, chunk] of boundaries.entries()) {
    const from = Math.floor(chunk.start * sampleRate);
    const to = Math.min(mono.length, Math.ceil(chunk.end * sampleRate));
    const slice = mono.subarray(from, to);
    const bitrate = chooseBitrate(chunk.end - chunk.start);

    const mp3 = await encodeMp3(slice, sampleRate, bitrate, (ratio) =>
      onProgress({
        stage: "encoding",
        ratio: (index + ratio) / boundaries.length,
      }),
    );

    if (mp3.size > GNANI_MAX_FILE_BYTES) {
      throw new AudioPrepareError(
        `A ${Math.round((chunk.end - chunk.start) / 60)} minute slice of this recording came to ${formatMb(mp3.size)} at ${bitrate} kbps, over the ${formatMb(GNANI_MAX_FILE_BYTES)} per-file limit of the transcription API.`,
        "This should not happen; please report the file that caused it.",
      );
    }

    parts.push({
      blob: mp3,
      filename:
        boundaries.length === 1
          ? `${base}.mp3`
          : `${base}-part${String(index + 1).padStart(2, "0")}.mp3`,
      contentType: "audio/mpeg",
      offsetSeconds: chunk.start,
      durationSeconds: chunk.end - chunk.start,
    });
  }

  onProgress({ stage: "done", ratio: 1 });

  return {
    parts,
    durationSeconds: Math.round(decoded.duration),
    transcoded: true,
    originalBytes: file.size,
  };
}

/**
 * Divides a recording into equal slices no longer than CHUNK_SECONDS.
 *
 * Equal lengths rather than one full slice plus a short remainder: a four
 * second tail would be its own file, its own job entry and its own chance to
 * fail, for no benefit.
 */
export function planChunks(
  durationSeconds: number,
): { start: number; end: number }[] {
  const count = Math.max(1, Math.ceil(durationSeconds / CHUNK_SECONDS));
  const length = durationSeconds / count;
  return Array.from({ length: count }, (_, index) => ({
    start: index * length,
    end: index === count - 1 ? durationSeconds : (index + 1) * length,
  }));
}

/**
 * Decodes at 16 kHz directly. Browsers resample during decode, so asking for the
 * target rate up front cuts peak memory roughly threefold versus decoding at
 * 44.1 kHz and resampling afterwards.
 */
async function decode(bytes: ArrayBuffer): Promise<AudioBuffer> {
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;

  if (!Ctor) {
    throw new AudioPrepareError(
      "This browser does not support the Web Audio API, which this app needs to read audio files.",
      "Try a current version of Chrome, Edge, Firefox or Safari.",
    );
  }

  let context: AudioContext;
  try {
    context = new Ctor({ sampleRate: TARGET_SAMPLE_RATE });
  } catch {
    context = new Ctor();
  }

  try {
    return await context.decodeAudioData(bytes);
  } catch {
    throw new AudioPrepareError(
      "This file could not be read as audio. It may be corrupt, or in a format this browser cannot decode.",
      "Supported formats include MP3, WAV, M4A, AAC, FLAC, OGG and WebM.",
    );
  } finally {
    void context.close();
  }
}

/** Speech ASR is mono; averaging channels also halves the encode workload. */
function downmixToMono(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);

  const length = buffer.length;
  const mixed = new Float32Array(length);
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    channels.push(buffer.getChannelData(c));
  }

  for (let i = 0; i < length; i += 1) {
    let sum = 0;
    for (let c = 0; c < channels.length; c += 1) sum += channels[c][i];
    mixed[i] = sum / channels.length;
  }

  return mixed;
}

/**
 * Picks the highest bitrate that still fits the whole recording under the cap,
 * so a short file keeps good fidelity and a very long one degrades gracefully
 * instead of being rejected.
 */
export function chooseBitrate(durationSeconds: number): number {
  const affordable = Math.floor((TARGET_MAX_BYTES * 8) / durationSeconds / 1000);
  return Math.max(MIN_BITRATE_KBPS, Math.min(MAX_BITRATE_KBPS, affordable));
}

/**
 * Encodes to MP3 in frame-aligned chunks, yielding to the event loop between
 * them so the progress bar keeps painting and the tab stays responsive.
 */
async function encodeMp3(
  samples: Float32Array,
  sampleRate: number,
  bitrateKbps: number,
  onProgress: (ratio: number) => void,
): Promise<Blob> {
  const encoder = new Mp3Encoder(1, sampleRate, bitrateKbps);
  const chunkSize = 1152 * 64;
  const output: Uint8Array[] = [];

  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }

  for (let offset = 0; offset < pcm.length; offset += chunkSize) {
    const slice = pcm.subarray(offset, Math.min(offset + chunkSize, pcm.length));
    const encoded = encoder.encodeBuffer(slice);
    if (encoded.length > 0) output.push(encoded);

    onProgress(Math.min(1, (offset + chunkSize) / pcm.length));
    await yieldToBrowser();
  }

  const tail = encoder.flush();
  if (tail.length > 0) output.push(tail);

  return new Blob(output as BlobPart[], { type: "audio/mpeg" });
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function replaceExtension(filename: string, extension: string): string {
  const base = filename.replace(/\.[^./\\]+$/, "");
  return `${base || "recording"}.${extension}`;
}

export function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
