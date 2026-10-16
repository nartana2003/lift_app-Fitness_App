import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const HOST = "https://my.lyfta.app";
const PAGE_SIZE = 50;
const MAX_PAGES = 40; // 2,000 workouts is far beyond what one account has

/**
 * Fetches a Lyfta account's workouts on the user's behalf (browsers can't call Lyfta directly).
 * The API key arrives in a header, is used for this request only, and is never stored or logged.
 * `?sandbox=1` uses Lyfta's public sample data (no key needed) for testing.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const sandbox = url.searchParams.get("sandbox") === "1";
  const key = req.headers.get("x-lyfta-key")?.trim();

  if (!sandbox && !key) return NextResponse.json({ error: "Add your Lyfta API key first." }, { status: 400 });

  const headers: Record<string, string> = { accept: "application/json" };
  if (!sandbox) headers.authorization = `Bearer ${key}`;

  const workouts: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const target = sandbox
      ? `${HOST}/api/sandbox/v1/workouts`
      : `${HOST}/api/v1/workouts?limit=${PAGE_SIZE}&page=${page}`;
    let res: Response;
    try {
      res = await fetch(target, { headers, cache: "no-store" });
    } catch {
      return NextResponse.json({ error: "Couldn't reach Lyfta. Check your connection and try again." }, { status: 502 });
    }
    if (res.status === 401 || res.status === 403)
      return NextResponse.json({ error: "Lyfta rejected that API key. Generate a new one in Lyfta and paste it again." }, { status: 401 });
    if (res.status === 429)
      return NextResponse.json({ error: "Lyfta says too many requests. Wait a minute and try again." }, { status: 429 });
    if (!res.ok) return NextResponse.json({ error: `Lyfta returned an error (${res.status}).` }, { status: 502 });

    const body = (await res.json()) as { workouts?: unknown[]; total_pages?: number };
    workouts.push(...(body.workouts ?? []));
    if (sandbox || !body.workouts?.length || page >= (body.total_pages ?? 1)) break;
  }

  return NextResponse.json({ workouts });
}
