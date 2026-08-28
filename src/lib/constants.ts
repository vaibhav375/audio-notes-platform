/**
 * Values shared by client and server code. Kept apart from `env.ts` so that no
 * server-side configuration logic is pulled into the browser bundle.
 */

/** Gnani's batch API rejects anything larger than this, per file. */
export const GNANI_MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Exactly what the batch transcription API accepts, taken from its own error
 * response rather than from documentation:
 *
 *   "Supported languages: bn-BD, bn-IN, en-IN, hi-IN, kn-IN, ml-IN, mr-IN,
 *    ta-IN, te-IN"
 *
 * Gujarati is deliberately absent. The synchronous endpoint transcribes it
 * happily, but the batch API rejects gu-IN outright, so offering it would mean
 * every Gujarati upload quietly taking the degraded fallback path while
 * appearing to be a first-class choice.
 */
export const SUPPORTED_LANGUAGES = [
  { code: "en-IN", label: "English (India)" },
  { code: "hi-IN", label: "Hindi" },
  { code: "kn-IN", label: "Kannada" },
  { code: "ta-IN", label: "Tamil" },
  { code: "te-IN", label: "Telugu" },
  { code: "ml-IN", label: "Malayalam" },
  { code: "mr-IN", label: "Marathi" },
  { code: "bn-IN", label: "Bengali (India)" },
  { code: "bn-BD", label: "Bengali (Bangladesh)" },
] as const;

export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number]["code"];
