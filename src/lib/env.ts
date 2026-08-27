/**
 * Central place for environment configuration.
 *
 * Values are read lazily rather than at module load so that `next build` (which
 * evaluates route modules without a full runtime environment) never fails just
 * because a secret is absent. Anything genuinely required is asserted at the
 * point of use, and surfaces as a readable error in the UI instead of a 500.
 */

export class ConfigError extends Error {
  constructor(name: string) {
    super(
      `Missing required environment variable ${name}. ` +
        `See .env.example for the full list.`,
    );
    this.name = "ConfigError";
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new ConfigError(name);
  return value;
}

export const env = {
  get databaseUrl() {
    return required("DATABASE_URL");
  },
  get gnaniApiKey() {
    return required("GNANI_API_KEY");
  },
  get gnaniBaseUrl() {
    return process.env.GNANI_BASE_URL ?? "https://api.vachana.ai";
  },
  get gnaniModel() {
    return process.env.GNANI_MODEL ?? "gnani-prisma-v2.5";
  },
  /**
   * Shared secret appended to the webhook URL handed to Gnani. Optional: when
   * unset the webhook is simply not registered and the app relies on polling.
   */
  get webhookSecret() {
    return process.env.GNANI_WEBHOOK_SECRET ?? "";
  },
  /**
   * Public origin of this deployment, used to build the callback URL. Vercel
   * injects VERCEL_PROJECT_PRODUCTION_URL automatically.
   */
  get publicOrigin(): string | null {
    if (process.env.APP_ORIGIN) return process.env.APP_ORIGIN.replace(/\/$/, "");
    const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
    if (vercel) return `https://${vercel}`;
    return null;
  },

  // Summarisation runs against any OpenAI-compatible /chat/completions endpoint.
  get llmBaseUrl() {
    return process.env.LLM_BASE_URL ?? "https://api.groq.com/openai/v1";
  },
  get llmApiKey() {
    return required("LLM_API_KEY");
  },
  get llmModel() {
    return process.env.LLM_MODEL ?? "qwen/qwen3.8-27b";
  },

  get repoUrl() {
    return (
      process.env.NEXT_PUBLIC_REPO_URL ??
      "https://github.com/vaibhav375/audio-notes-platform"
    );
  },
};
