import { getNote } from "@/lib/pipeline";
import {
  contentType,
  exportFilename,
  isExportFormat,
  render,
} from "@/lib/export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/**
 * Serves a recording as a downloadable file.
 *
 * Rendered server-side so the browser gets a real Content-Disposition and the
 * subtitle formats are built from the stored segment timings rather than
 * guessed at in the client.
 */
export async function GET(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  const format = new URL(request.url).searchParams.get("format") ?? "txt";

  if (!isExportFormat(format)) {
    return Response.json(
      { error: `Unsupported export format "${format}".` },
      { status: 400 },
    );
  }

  const note = await getNote(id);
  if (!note) {
    return Response.json({ error: "That upload does not exist." }, { status: 404 });
  }

  if (!note.transcript) {
    return Response.json(
      { error: "This recording has no transcript to export yet." },
      { status: 409 },
    );
  }

  if ((format === "srt" || format === "vtt") && !note.segments?.length) {
    return Response.json(
      {
        error:
          "Subtitles need per-segment timings, which this recording does not have.",
      },
      { status: 409 },
    );
  }

  return new Response(render(note, format), {
    headers: {
      "Content-Type": contentType(format),
      "Content-Disposition": `attachment; filename="${exportFilename(note, format)}"`,
      "Cache-Control": "no-store",
    },
  });
}
