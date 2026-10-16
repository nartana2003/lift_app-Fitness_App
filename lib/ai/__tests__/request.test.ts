import { afterEach, describe, expect, it, vi } from "vitest";
import { setAiClientFactory, type AiClient, type AiParams } from "../client";
import { MAX_BODY_BYTES } from "../generate-routines";
import { invalidRequest, readJsonBody } from "../request";
import { POST } from "../../../app/api/ai/generate-routines/route";

// --- helpers ----------------------------------------------------------------

const URL_ = "http://localhost/api/ai/test";
const enc = new TextEncoder();

/** A Request over a chunked stream: no Content-Length header is set. */
function streamRequest(stream: ReadableStream<Uint8Array>, headers: Record<string, string> = {}): Request {
  return new Request(URL_, { method: "POST", body: stream, headers, duplex: "half" } as RequestInit);
}

function chunksStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
}

/** An effectively endless stream (up to 100 MB) that records how much was pulled. */
function hugeStream(chunkSize: number) {
  const stats = { pulled: 0, bytes: 0, cancelled: false };
  const limit = 100 * 1024 * 1024;
  const chunk = new Uint8Array(chunkSize).fill(0x61); // "a"
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (stats.bytes >= limit) return controller.close();
        stats.pulled += 1;
        stats.bytes += chunkSize;
        controller.enqueue(chunk.slice());
      },
      cancel() {
        stats.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, stats };
}

function fakeClient() {
  const calls: AiParams[] = [];
  const client: AiClient = {
    createMessage: async (p) => {
      calls.push(p);
      throw new Error("model must not be called");
    },
  };
  setAiClientFactory(() => client);
  return calls;
}

// --- readJsonBody -----------------------------------------------------------

describe("readJsonBody", () => {
  it("parses a valid JSON body", async () => {
    const req = new Request(URL_, { method: "POST", body: JSON.stringify({ a: 1, b: ["x"] }) });
    expect(await readJsonBody(req, 1024)).toEqual({ ok: true, value: { a: 1, b: ["x"] } });
  });

  it("accepts a body exactly at the cap", async () => {
    const body = JSON.stringify("x".repeat(98)); // 100 bytes
    const req = new Request(URL_, { method: "POST", body });
    expect(await readJsonBody(req, 100)).toEqual({ ok: true, value: "x".repeat(98) });
  });

  it("rejects 413 from Content-Length before reading the body", async () => {
    const { stream, stats } = hugeStream(1024);
    const req = streamRequest(stream, { "content-length": String(10_000) });
    expect(await readJsonBody(req, 1024)).toEqual({ ok: false, status: 413 });
    expect(stats.pulled).toBe(0);
  });

  it("rejects 413 over the cap with no Content-Length (chunked stream)", async () => {
    const req = streamRequest(
      chunksStream([enc.encode('{"pad":"'), enc.encode("x".repeat(600)), enc.encode("x".repeat(600) + '"}')]),
    );
    expect(req.headers.get("content-length")).toBeNull();
    expect(await readJsonBody(req, 1024)).toEqual({ ok: false, status: 413 });
  });

  it("rejects 413 when Content-Length lies low", async () => {
    const req = streamRequest(chunksStream([enc.encode("x".repeat(2000))]), { "content-length": "10" });
    expect(await readJsonBody(req, 1024)).toEqual({ ok: false, status: 413 });
  });

  it("stops reading a huge stream soon after the cap and cancels it", async () => {
    const { stream, stats } = hugeStream(1024);
    const req = streamRequest(stream);
    expect(await readJsonBody(req, 16_384)).toEqual({ ok: false, status: 413 });
    // 16 chunks fill the cap and the 17th crosses it; allow a little read-ahead.
    expect(stats.pulled).toBeLessThanOrEqual(20);
    expect(stats.bytes).toBeLessThan(32 * 1024);
    await new Promise((r) => setTimeout(r, 0));
    expect(stats.cancelled).toBe(true);
  });

  it("rejects 400 for invalid JSON", async () => {
    const req = new Request(URL_, { method: "POST", body: "not json" });
    expect(await readJsonBody(req, 1024)).toEqual({ ok: false, status: 400 });
  });

  it("rejects 400 for an empty body, a whitespace body and no body", async () => {
    expect(await readJsonBody(new Request(URL_, { method: "POST", body: "" }), 1024)).toEqual({ ok: false, status: 400 });
    expect(await readJsonBody(new Request(URL_, { method: "POST", body: "  \n " }), 1024)).toEqual({ ok: false, status: 400 });
    expect(await readJsonBody(new Request(URL_, { method: "POST" }), 1024)).toEqual({ ok: false, status: 400 });
    expect(await readJsonBody(streamRequest(chunksStream([])), 1024)).toEqual({ ok: false, status: 400 });
  });

  it("rejects 400 for a body that was already read", async () => {
    const req = new Request(URL_, { method: "POST", body: "{}" });
    await req.text();
    expect(await readJsonBody(req, 1024)).toEqual({ ok: false, status: 400 });
  });

  it("rejects 400 when the stream errors mid-read", async () => {
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(enc.encode('{"a":'));
        } else controller.error(new Error("socket reset"));
      },
    });
    expect(await readJsonBody(streamRequest(stream), 1024)).toEqual({ ok: false, status: 400 });
  });

  it("decodes a multi-byte UTF-8 character split across chunks", async () => {
    const name = "Bench é€\u{1F4AA}";
    const bytes = enc.encode(JSON.stringify({ name }));
    // Split inside the 3-byte euro sign and inside the 4-byte emoji.
    const euro = bytes.indexOf(0xe2);
    const four = bytes.indexOf(0xf0);
    const req = streamRequest(
      chunksStream([bytes.slice(0, euro + 1), bytes.slice(euro + 1, four + 2), bytes.slice(four + 2)]),
    );
    expect(await readJsonBody(req, 1024)).toEqual({ ok: true, value: { name } });
  });

  it("counts bytes, not characters, against the cap", async () => {
    const body = JSON.stringify("€".repeat(40)); // 40 chars, 122 bytes
    expect(await readJsonBody(streamRequest(chunksStream([enc.encode(body)])), 100)).toEqual({ ok: false, status: 413 });
  });

  it("invalidRequest returns the fixed body", async () => {
    const res = invalidRequest(413);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "invalid_request" });
    expect(invalidRequest().status).toBe(400);
  });
});

// --- route integration: the model is never called on rejection --------------

describe("generate-routines route body limits", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    setAiClientFactory(null);
  });

  it("answers 503 before reading the body when there is no key", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const calls = fakeClient();
    const { stream, stats } = hugeStream(1024);
    const res = await POST(streamRequest(stream));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ unavailable: true });
    expect(stats.pulled).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("413s a chunked body with no Content-Length, stops early, never calls the model", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test-key");
    const calls = fakeClient();
    const { stream, stats } = hugeStream(1024);
    const res = await POST(streamRequest(stream));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "invalid_request" });
    expect(stats.bytes).toBeLessThan(MAX_BODY_BYTES * 2);
    expect(calls).toHaveLength(0);
  });

  it("413s on a declared Content-Length over the cap without calling the model", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test-key");
    const calls = fakeClient();
    const { stream, stats } = hugeStream(1024);
    const res = await POST(streamRequest(stream, { "content-length": String(MAX_BODY_BYTES + 1) }));
    expect(res.status).toBe(413);
    expect(stats.pulled).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("400s empty and invalid JSON without calling the model", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test-key");
    const calls = fakeClient();
    for (const body of ["", "{", "not json"]) {
      const res = await POST(new Request(URL_, { method: "POST", body }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_request" });
    }
    expect(calls).toHaveLength(0);
  });
});
