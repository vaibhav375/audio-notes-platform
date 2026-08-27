/**
 * Structured logging.
 *
 * Every line is one JSON object on one line, always carrying the note id. That
 * is what makes a platform's log search able to answer "what happened to this
 * recording?" without reading the database, which is how most of the bugs in
 * this pipeline were actually found.
 */

type Level = "info" | "warn" | "error";

type Fields = Record<string, string | number | boolean | null | undefined>;

function emit(level: Level, event: string, fields: Fields = {}): void {
  const line = JSON.stringify({
    level,
    event,
    at: new Date().toISOString(),
    ...fields,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (event: string, fields?: Fields) => emit("info", event, fields),
  warn: (event: string, fields?: Fields) => emit("warn", event, fields),
  error: (event: string, fields?: Fields) => emit("error", event, fields),
};
