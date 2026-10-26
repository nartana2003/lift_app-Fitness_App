/**
 * Shared request-body reader for app/api/ai/* routes.
 *
 * Reads the body as a stream with a hard byte cap. Content-Length is checked
 * first as a cheap early reject, but it is never trusted: a chunked request
 * with no (or a lying) Content-Length is counted byte by byte, and the reader
 * is cancelled as soon as the cap is exceeded, so nothing past the cap is
 * buffered. Nothing here calls the model.
 */

export type JsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413 };

/** Fixed rejection body shared by the AI routes. No detail leaks to the client. */
export function invalidRequest(status: 400 | 413 = 400): Response {
  return Response.json({ error: "invalid_request" }, { status });
}

/**
 * Read `req`'s body as JSON with at most `maxBytes` bytes.
 * - 413 when Content-Length declares more than the cap, or the stream exceeds it.
 * - 400 for an empty body, invalid JSON, or a body that cannot be read.
 */
export async function readJsonBody(req: Request, maxBytes: number): Promise<JsonBodyResult> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > maxBytes) return { ok: false, status: 413 };

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    if (req.bodyUsed) return { ok: false, status: 400 };
    if (!req.body) return { ok: false, status: 400 };
    reader = req.body.getReader();
  } catch {
    return { ok: false, status: 400 };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        // Stop pulling and tell the source to stop producing. Do not await
        // forever on a misbehaving source.
        reader.cancel().catch(() => {});
        return { ok: false, status: 413 };
      }
      chunks.push(value);
    }
  } catch {
    reader.cancel().catch(() => {});
    return { ok: false, status: 400 };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released or errored
    }
  }

  // Join first, then decode once, so a multi-byte UTF-8 character split
  // across chunks decodes correctly.
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  if (text.trim() === "") return { ok: false, status: 400 };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, status: 400 };
  }
}
