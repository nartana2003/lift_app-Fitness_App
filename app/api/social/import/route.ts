import { invalidRequest, readJsonBody } from "@/lib/ai/request";
import { MAX_BODY_BYTES, importLink, parseLink, validateBody } from "@/lib/social/oembed";

export const dynamic = "force-dynamic";

/**
 * POST { url } -> 200 { platform, title, thumbnail_url, creator } for a TikTok
 * or YouTube/Shorts link, read from the platform's public oEmbed endpoint.
 * Instagram, and any oEmbed failure, answers 200 { platform, manual: true } so
 * the client falls back to the pasted caption. 400/413 for a bad body or a
 * link that is not https on an allow-listed host. No key or env is needed;
 * auth follows the normal middleware rules.
 */
export async function POST(req: Request): Promise<Response> {
  const body = await readJsonBody(req, MAX_BODY_BYTES);
  if (!body.ok) return invalidRequest(body.status);
  const checked = validateBody(body.value);
  if (!checked) return invalidRequest();
  const link = parseLink(checked.url);
  if (!link) return invalidRequest();
  try {
    return Response.json(await importLink(link), { status: 200 });
  } catch {
    return Response.json({ error: "error" }, { status: 502 });
  }
}
