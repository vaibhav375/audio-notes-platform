import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { env } from "@/lib/env";
import * as schema from "./schema";

let cached: ReturnType<typeof drizzle<typeof schema>> | null = null;

/**
 * Neon's HTTP driver is stateless, so a module-level singleton is safe across
 * serverless invocations and avoids re-parsing the connection string per call.
 */
export function db() {
  if (!cached) {
    cached = drizzle(neon(env.databaseUrl), { schema });
  }
  return cached;
}

export { schema };
