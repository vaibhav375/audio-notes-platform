import { searchNotes } from "@/lib/search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const query = new URL(request.url).searchParams.get("q") ?? "";

  if (!query.trim()) return Response.json({ hits: [], query: "" });

  try {
    return Response.json({ query, hits: await searchNotes(query) });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Could not run that search.",
      },
      { status: 500 },
    );
  }
}
