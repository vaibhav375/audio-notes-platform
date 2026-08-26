/**
 * Values shared by client and server code. Kept apart from `env.ts` so that no
 * server-side configuration logic is pulled into the browser bundle.
 */

/** Gnani's batch API rejects anything larger than this, per file. */
export const GNANI_MAX_FILE_BYTES = 10 * 1024 * 1024;

export const SUPPORTED_LANGUAGES = [
  { code: "en-IN", label: "English (India)" },
  { code: "hi-IN", label: "Hindi" },
  { code: "kn-IN", label: "Kannada" },
  { code: "ta-IN", label: "Tamil" },
  { code: "te-IN", label: "Telugu" },
  { code: "ml-IN", label: "Malayalam" },
  { code: "mr-IN", label: "Marathi" },
  { code: "bn-IN", label: "Bengali" },
  { code: "gu-IN", label: "Gujarati" },
] as const;

export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number]["code"];
