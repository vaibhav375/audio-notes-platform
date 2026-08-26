import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { GNANI_MAX_FILE_BYTES } from "@/lib/constants";

export const runtime = "nodejs";

/**
 * Issues short-lived tokens so the browser can upload straight to blob storage.
 *
 * Uploading through this function instead would cap the request body far below
 * the 10 MB of audio Gnani accepts, so the bytes never transit the API layer.
 */
export async function POST(request: Request): Promise<Response> {
  let body: HandleUploadBody;
  try {
    body = (await request.json()) as HandleUploadBody;
  } catch {
    return Response.json({ error: "Malformed upload request." }, { status: 400 });
  }

  try {
    const result = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: [
          "audio/mpeg",
          "audio/mp3",
          "audio/wav",
          "audio/x-wav",
          "audio/webm",
          "audio/ogg",
          "audio/flac",
          "audio/x-flac",
          "audio/mp4",
          "audio/m4a",
          "audio/x-m4a",
          "audio/aac",
          "video/mp4",
          "video/webm",
        ],
        maximumSizeInBytes: GNANI_MAX_FILE_BYTES,
        addRandomSuffix: true,
      }),
      // Nothing to do on completion: the client creates the note record itself,
      // which keeps the "was it accepted by Gnani?" answer inside the request
      // the user is actually waiting on.
      onUploadCompleted: async () => {},
    });

    return Response.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not authorise the upload.";
    return Response.json(
      { error: `Upload storage rejected the file: ${message}` },
      { status: 400 },
    );
  }
}
