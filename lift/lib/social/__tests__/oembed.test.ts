import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALLOWED_HOSTS,
  MAX_BODY_BYTES,
  MAX_CREATOR,
  MAX_TITLE,
  MAX_URL,
  OEMBED_ENDPOINTS,
  cleanText,
  cleanThumbnail,
  fetchOEmbed,
  fetchTikTokCover,
  parseCoverUrl,
  importLink,
  oembedUrl,
  parseLink,
  parseOEmbed,
  parseOEmbedText,
  readCappedText,
  validateBody,
  type FetchLike,
  type ParsedLink,
} from "../oembed";
import { POST } from "../../../app/api/social/import/route";

const TIKTOK = "https://www.tiktok.com/@coach/video/7300000000000000000";
const SHORT = "https://www.youtube.com/shorts/abcDEF12345";

const tiktokJson = {
  version: "1.0",
  type: "video",
  title: "10 min ab finisher #abs",
  author_name: "Coach Sam",
  author_url: "https://www.tiktok.com/@coach",
  thumbnail_url: "https://p16-sign.tiktokcdn.com/obj/thumb.jpeg",
  html: "<blockquote>...</blockquote>",
};

const youtubeJson = {
  title: "Leg day in 8 minutes",
  author_name: "Lift Channel",
  thumbnail_url: "https://i.ytimg.com/vi/abcDEF12345/hqdefault.jpg",
  provider_name: "YouTube",
};

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
    ...init,
  });

const link = (url: string): ParsedLink => {
  const l = parseLink(url);
  if (!l) throw new Error(`bad fixture ${url}`);
  return l;
};

// ---------------------------------------------------------------------------

describe("parseLink", () => {
  it("accepts https links on every allow-listed host", () => {
    expect(parseLink(TIKTOK)).toEqual({ url: TIKTOK, platform: "tiktok" });
    expect(parseLink("https://tiktok.com/@a/video/1")?.platform).toBe("tiktok");
    expect(parseLink(" https://vm.tiktok.com/ZM123/ ")).toEqual({ url: "https://vm.tiktok.com/ZM123/", platform: "tiktok" });
    expect(parseLink(SHORT)?.platform).toBe("youtube");
    expect(parseLink("https://youtube.com/watch?v=x")?.platform).toBe("youtube");
    expect(parseLink("https://m.youtube.com/shorts/xyz")?.platform).toBe("youtube");
    expect(parseLink("https://youtu.be/xyz")?.platform).toBe("youtube");
    expect(parseLink("https://www.instagram.com/reel/abc/")?.platform).toBe("instagram");
    expect(parseLink("https://instagram.com/p/abc")?.platform).toBe("instagram");
    expect(parseLink("HTTPS://WWW.TIKTOK.COM/@a/video/1")?.url).toBe("https://www.tiktok.com/@a/video/1");
  });

  it("allow-list is exactly the nine hosts", () => {
    expect(Object.keys(ALLOWED_HOSTS).sort()).toEqual(
      [
        "instagram.com",
        "m.youtube.com",
        "tiktok.com",
        "vm.tiktok.com",
        "www.instagram.com",
        "www.tiktok.com",
        "www.youtube.com",
        "youtu.be",
        "youtube.com",
      ].sort(),
    );
  });

  it("rejects lookalike and unlisted hosts", () => {
    for (const bad of [
      "https://tiktok.com.evil.io/x",
      "https://evil.io/tiktok.com",
      "https://faketiktok.com/x",
      "https://eviltiktok.com/x",
      "https://vt.tiktok.com/x",
      "https://music.youtube.com/watch?v=x",
      "https://youtu.be.evil.io/x",
      "https://www.tiktok.com./x",
      "https://xn--tktok-pta.com/x",
      "https://tіktok.com/x", // Cyrillic i
      "https://localhost/x",
      "https://127.0.0.1/x",
      "https://[::1]/x",
      "https://169.254.169.254/latest/meta-data",
    ]) {
      expect(parseLink(bad), bad).toBeNull();
    }
  });

  it("rejects user@host and credential tricks", () => {
    expect(parseLink("https://user:pw@tiktok.com/x")).toBeNull();
    expect(parseLink("https://tiktok.com@evil.io/x")).toBeNull();
    expect(parseLink("https://www.youtube.com:pw@evil.io/x")).toBeNull();
    expect(parseLink("https://evil.io@www.tiktok.com/x")).toBeNull();
  });

  it("rejects non-https schemes and odd spellings", () => {
    for (const bad of [
      "http://www.tiktok.com/@a/video/1",
      "javascript:alert(1)//www.tiktok.com",
      "JavaScript:alert(1)",
      "data:text/html,www.tiktok.com",
      "ftp://tiktok.com/x",
      "file:///etc/passwd",
      "//www.tiktok.com/x",
      "www.tiktok.com/x",
      "https:www.tiktok.com/x",
      "https:/www.tiktok.com/x",
      "https://www.tiktok.com:8443/x",
      "https://www.tiktok.com:443x/x",
    ]) {
      expect(parseLink(bad), bad).toBeNull();
    }
  });

  it("rejects non-strings, empty, oversized and whitespace or control inside", () => {
    expect(parseLink(undefined)).toBeNull();
    expect(parseLink(42)).toBeNull();
    expect(parseLink({ url: TIKTOK })).toBeNull();
    expect(parseLink("")).toBeNull();
    expect(parseLink("   ")).toBeNull();
    expect(parseLink(`https://www.tiktok.com/${"a".repeat(MAX_URL)}`)).toBeNull();
    expect(parseLink("https://www.tiktok.com/a b")).toBeNull();
    expect(parseLink("https://www.tiktok.com/a\nb")).toBeNull();
    expect(parseLink("https://www.tik\ttok.com/a")).toBeNull();
    expect(parseLink("https://www.tiktok.com/a\u0000")).toBeNull();
  });

  it("a backslash path stays on the allow-listed host", () => {
    // WHATWG treats "\" as "/" for https, so the host is still tiktok.com.
    const r = parseLink("https://tiktok.com\\@evil.io/x");
    expect(r === null || new URL(r.url).hostname === "tiktok.com").toBe(true);
  });
});

describe("validateBody", () => {
  it("accepts exactly { url: string }", () => {
    expect(validateBody({ url: TIKTOK })).toEqual({ url: TIKTOK });
  });
  it("rejects unknown keys, wrong types and non-objects", () => {
    expect(validateBody({ url: TIKTOK, host: "evil.io" })).toBeNull();
    expect(validateBody({ url: 1 })).toBeNull();
    expect(validateBody({})).toBeNull();
    expect(validateBody([TIKTOK])).toBeNull();
    expect(validateBody(null)).toBeNull();
    expect(validateBody(TIKTOK)).toBeNull();
  });
});

describe("oembedUrl", () => {
  it("only ever targets the fixed endpoints, user link as a query parameter", () => {
    const t = new URL(oembedUrl(link(TIKTOK))!);
    expect(`${t.origin}${t.pathname}`).toBe("https://www.tiktok.com/oembed");
    expect(t.searchParams.get("url")).toBe(TIKTOK);

    const y = new URL(oembedUrl(link(SHORT))!);
    expect(`${y.origin}${y.pathname}`).toBe("https://www.youtube.com/oembed");
    expect(y.searchParams.get("url")).toBe(SHORT);
    expect(y.searchParams.get("format")).toBe("json");
  });

  it("a link with its own query and fragment cannot add parameters", () => {
    const tricky = "https://youtu.be/x?format=xml&url=https://evil.io#frag";
    const y = new URL(oembedUrl(link(tricky))!);
    expect(y.host).toBe("www.youtube.com");
    expect(y.searchParams.getAll("url")).toEqual([new URL(tricky).href]);
    expect(y.searchParams.getAll("format")).toEqual(["json"]);
  });

  it("instagram has no endpoint", () => {
    expect(oembedUrl(link("https://www.instagram.com/reel/abc/"))).toBeNull();
    expect(OEMBED_ENDPOINTS.instagram).toBeUndefined();
  });
});

describe("parseOEmbed", () => {
  it("reads title, author_name and thumbnail_url from TikTok and YouTube answers", () => {
    expect(parseOEmbed(tiktokJson, "tiktok")).toEqual({
      platform: "tiktok",
      title: "10 min ab finisher #abs",
      thumbnail_url: "https://p16-sign.tiktokcdn.com/obj/thumb.jpeg",
      creator: "Coach Sam",
    });
    expect(parseOEmbed(youtubeJson, "youtube")).toEqual({
      platform: "youtube",
      title: "Leg day in 8 minutes",
      thumbnail_url: "https://i.ytimg.com/vi/abcDEF12345/hqdefault.jpg",
      creator: "Lift Channel",
    });
  });

  it("drops html and other fields", () => {
    const r = parseOEmbed(tiktokJson, "tiktok")!;
    expect(Object.keys(r).sort()).toEqual(["creator", "platform", "thumbnail_url", "title"]);
  });

  it("nulls bad fields but keeps good ones", () => {
    expect(parseOEmbed({ title: 5, author_name: "A", thumbnail_url: "http://x.io/a.jpg" }, "youtube")).toEqual({
      platform: "youtube",
      title: null,
      thumbnail_url: null,
      creator: "A",
    });
    expect(parseOEmbed({ title: "T", thumbnail_url: "javascript:alert(1)" }, "tiktok")?.thumbnail_url).toBeNull();
    expect(parseOEmbed({ title: "T", thumbnail_url: "https://u:p@x.io/a.jpg" }, "tiktok")?.thumbnail_url).toBeNull();
    expect(parseOEmbed({ title: "T", thumbnail_url: "data:image/png;base64,AAAA" }, "tiktok")?.thumbnail_url).toBeNull();
  });

  it("null for non-objects or answers with nothing usable", () => {
    expect(parseOEmbed(null, "tiktok")).toBeNull();
    expect(parseOEmbed([], "tiktok")).toBeNull();
    expect(parseOEmbed("title", "tiktok")).toBeNull();
    expect(parseOEmbed({}, "tiktok")).toBeNull();
    expect(parseOEmbed({ title: "   ", author_name: "​" }, "tiktok")).toBeNull();
  });

  it("cleans and caps text", () => {
    const r = parseOEmbed(
      { title: `  Abs\u0000 \n\tworkout‮  ${"x".repeat(MAX_TITLE * 2)}`, author_name: "y".repeat(MAX_CREATOR + 50) },
      "tiktok",
    )!;
    expect(r.title!.startsWith("Abs workout x")).toBe(true);
    expect(Array.from(r.title!).length).toBeLessThanOrEqual(MAX_TITLE);
    expect(r.title).not.toMatch(/[\u0000-\u001f‮]/);
    expect(r.creator!.length).toBe(MAX_CREATOR);
  });

  it("parseOEmbedText handles malformed JSON", () => {
    expect(parseOEmbedText("{not json", "tiktok")).toBeNull();
    expect(parseOEmbedText("", "tiktok")).toBeNull();
    expect(parseOEmbedText("<html>blocked</html>", "youtube")).toBeNull();
    expect(parseOEmbedText(JSON.stringify(youtubeJson), "youtube")?.title).toBe("Leg day in 8 minutes");
  });

  it("cleanText and cleanThumbnail edge cases", () => {
    expect(cleanText(undefined, 10)).toBeNull();
    expect(cleanText("ｆｕｌｌ", 10)).toBe("full");
    expect(cleanText("😀😀😀", 2)).toBe("😀😀");
    expect(cleanThumbnail("https://x.io/a b.jpg")).toBeNull();
    expect(cleanThumbnail(`https://x.io/${"a".repeat(3000)}`)).toBeNull();
    expect(cleanThumbnail("https://x.io/a.jpg")).toBe("https://x.io/a.jpg");
  });
});

// ---------------------------------------------------------------------------
// Fetch (mocked only, no real network)
// ---------------------------------------------------------------------------

type Call = { url: string; init?: RequestInit };
const mockFetch = (res: () => Response | Promise<Response>) => {
  const calls: Call[] = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return res();
  };
  return { fn, calls };
};

describe("fetchOEmbed", () => {
  it("fetches only the fixed endpoint with manual redirects and a signal", async () => {
    const m = mockFetch(() => jsonResponse(tiktokJson));
    const r = await fetchOEmbed(link(TIKTOK), { fetchImpl: m.fn });
    expect(r?.title).toBe("10 min ab finisher #abs");
    expect(m.calls).toHaveLength(1);
    const u = new URL(m.calls[0].url);
    expect(`${u.origin}${u.pathname}`).toBe("https://www.tiktok.com/oembed");
    expect(m.calls[0].init?.redirect).toBe("manual");
    expect(m.calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("never fetches for instagram", async () => {
    const m = mockFetch(() => jsonResponse(tiktokJson));
    expect(await fetchOEmbed(link("https://www.instagram.com/reel/abc/"), { fetchImpl: m.fn })).toBeNull();
    expect(m.calls).toHaveLength(0);
  });

  it("null on redirects, non-200, non-JSON content, malformed or oversized bodies", async () => {
    const cases: Response[] = [
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }),
      jsonResponse(tiktokJson, { status: 404 }),
      jsonResponse(tiktokJson, { status: 500 }),
      new Response(JSON.stringify(tiktokJson), { status: 200, headers: { "content-type": "text/html" } }),
      new Response(JSON.stringify(tiktokJson), { status: 200 }),
      new Response(JSON.stringify(tiktokJson), { status: 200, headers: { "content-type": "application/jsonp" } }),
      jsonResponse("{oops"),
      jsonResponse({ ...tiktokJson, pad: "x".repeat(70_000) }),
    ];
    for (const res of cases) {
      expect(await fetchOEmbed(link(TIKTOK), { fetchImpl: async () => res })).toBeNull();
    }
  });

  it("null when the body exceeds the cap with no content-length (streamed)", async () => {
    const big = new TextEncoder().encode("x".repeat(1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        sent += 1;
        if (sent > 1000) c.close();
        else c.enqueue(big);
      },
    });
    const res = new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
    expect(await fetchOEmbed(link(TIKTOK), { fetchImpl: async () => res, maxBytes: 4096 })).toBeNull();
    expect(sent).toBeLessThan(20);
  });

  it("null when content-length declares more than the cap", async () => {
    const res = new Response("{}", { status: 200, headers: { "content-type": "application/json", "content-length": "999999" } });
    expect(await readCappedText(res, 1000)).toBeNull();
  });

  it("null on a network error", async () => {
    expect(
      await fetchOEmbed(link(TIKTOK), {
        fetchImpl: async () => {
          throw new TypeError("fetch failed");
        },
      }),
    ).toBeNull();
  });

  it("null on timeout (aborts the request)", async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    expect(await fetchOEmbed(link(SHORT), { fetchImpl: hang, timeoutMs: 20 })).toBeNull();
  });

  it("importLink answers manual for instagram and failures", async () => {
    const ok = mockFetch(() => jsonResponse(youtubeJson));
    expect(await importLink(link(SHORT), { fetchImpl: ok.fn })).toEqual({
      platform: "youtube",
      title: "Leg day in 8 minutes",
      thumbnail_url: "https://i.ytimg.com/vi/abcDEF12345/hqdefault.jpg",
      creator: "Lift Channel",
    });
    const bad = mockFetch(() => jsonResponse({}, { status: 500 }));
    expect(await importLink(link(SHORT), { fetchImpl: bad.fn })).toEqual({ platform: "youtube", manual: true });
    const never = mockFetch(() => jsonResponse(youtubeJson));
    expect(await importLink(link("https://instagram.com/reel/x"), { fetchImpl: never.fn })).toEqual({ platform: "instagram", manual: true });
    expect(never.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Route (global fetch stubbed, no real network)
// ---------------------------------------------------------------------------

const ROUTE_URL = "http://localhost/api/social/import";
const post = (body: unknown) =>
  POST(new Request(ROUTE_URL, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));

describe("POST /api/social/import", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stub = (res: () => Response) => {
    const spy = vi.fn(async (_url: string, _init?: RequestInit) => res());
    vi.stubGlobal("fetch", spy);
    return spy;
  };

  it("TikTok: 200 with title, thumbnail and creator", async () => {
    const spy = stub(() => jsonResponse(tiktokJson));
    const res = await post({ url: TIKTOK });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      platform: "tiktok",
      title: "10 min ab finisher #abs",
      thumbnail_url: "https://p16-sign.tiktokcdn.com/obj/thumb.jpeg",
      creator: "Coach Sam",
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const u = new URL(spy.mock.calls[0][0]);
    expect(u.host).toBe("www.tiktok.com");
    expect(u.pathname).toBe("/oembed");
    expect(spy.mock.calls[0][1]?.redirect).toBe("manual");
  });

  it("YouTube Shorts: 200 with details from the YouTube endpoint", async () => {
    const spy = stub(() => jsonResponse(youtubeJson));
    const res = await post({ url: SHORT });
    expect(res.status).toBe(200);
    expect((await res.json()).creator).toBe("Lift Channel");
    expect(new URL(spy.mock.calls[0][0]).host).toBe("www.youtube.com");
  });

  it("Instagram: 200 manual, nothing fetched", async () => {
    const spy = stub(() => jsonResponse(tiktokJson));
    const res = await post({ url: "https://www.instagram.com/reel/abc/" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ platform: "instagram", manual: true });
    expect(spy).not.toHaveBeenCalled();
  });

  it("upstream failure: 200 manual, no detail leaked", async () => {
    stub(() => {
      throw new Error("secret internal detail");
    });
    const res = await post({ url: TIKTOK });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ platform: "tiktok", manual: true });
    expect(text).not.toMatch(/secret|Error|stack/);
  });

  it("400 for bad links without fetching", async () => {
    const spy = stub(() => jsonResponse(tiktokJson));
    for (const url of [
      "https://tiktok.com.evil.io/x",
      "https://tiktok.com@evil.io/x",
      "http://www.tiktok.com/@a/video/1",
      "javascript:alert(1)",
      "https://example.com/",
    ]) {
      const res = await post({ url });
      expect(res.status, url).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_request" });
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("400 for unknown keys, malformed JSON and empty bodies; 413 when oversized", async () => {
    const spy = stub(() => jsonResponse(tiktokJson));
    expect((await post({ url: TIKTOK, endpoint: "https://evil.io" })).status).toBe(400);
    expect((await post("{bad json")).status).toBe(400);
    expect((await post("")).status).toBe(400);
    expect((await post({ url: 5 })).status).toBe(400);
    expect((await post({ url: `https://www.tiktok.com/${"a".repeat(MAX_BODY_BYTES)}` })).status).toBe(413);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("TikTok cover image", () => {
  const COVER = "https://p16-common-sign.tiktokcdn.com/tos/abc~tplv.image?x-expires=1";
  const page = (cover: string) => `<html><script>{"video":{"cover":${JSON.stringify(cover)}}}</script></html>`;
  const tt: ParsedLink = { url: TIKTOK, platform: "tiktok" };
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

  const router = (cover: string, imageType = "image/jpeg", oembed: unknown = { html: "x" }): FetchLike =>
    vi.fn(async (input: string) => {
      if (input.startsWith("https://www.tiktok.com/oembed")) {
        return new Response(JSON.stringify(oembed), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (input === TIKTOK) return new Response(page(cover), { status: 200, headers: { "content-type": "text/html" } });
      return new Response(bytes, { status: 200, headers: { "content-type": imageType } });
    });

  it("reads the cover url only from a tiktokcdn host", () => {
    expect(parseCoverUrl(page(COVER))).toBe(COVER);
    expect(parseCoverUrl(page("https://evil.example.com/a.jpg"))).toBeNull();
    expect(parseCoverUrl(page("https://tiktokcdn.com.evil.com/a.jpg"))).toBeNull();
    expect(parseCoverUrl(page("http://p16.tiktokcdn.com/a.jpg"))).toBeNull();
    expect(parseCoverUrl("<html></html>")).toBeNull();
  });

  it("returns the cover as a data url", async () => {
    expect(await fetchTikTokCover(tt, { fetchImpl: router(COVER) })).toBe(`data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`);
  });

  it("is null for a non-image answer, an oversized image or a failing page", async () => {
    expect(await fetchTikTokCover(tt, { fetchImpl: router(COVER, "text/html") })).toBeNull();
    expect(await fetchTikTokCover(tt, { fetchImpl: router(COVER), maxBytes: 1 })).toBeNull();
    expect(await fetchTikTokCover(tt, { fetchImpl: vi.fn(async () => { throw new Error("down"); }) })).toBeNull();
    expect(await fetchTikTokCover({ url: SHORT, platform: "youtube" }, { fetchImpl: router(COVER) })).toBeNull();
  });

  it("importLink adds the cover when oEmbed has no thumbnail", async () => {
    const r = await importLink(tt, { fetchImpl: router(COVER) });
    expect(r).toMatchObject({ platform: "tiktok", thumbnail_url: null });
    expect((r as { cover_data_url?: string }).cover_data_url).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("importLink keeps oEmbed's own thumbnail and skips the page", async () => {
    const fn = router(COVER, "image/jpeg", tiktokJson);
    const r = await importLink(tt, { fetchImpl: fn });
    expect(r).toMatchObject({ thumbnail_url: tiktokJson.thumbnail_url });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
