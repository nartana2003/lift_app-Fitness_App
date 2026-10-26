import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  AI_FALLBACK_BETA,
  AI_MAX_TOKENS,
  AI_MODEL,
  buildParams,
  getAiClient,
  messageText,
  runAi,
  sdkClientFactory,
  setAiClientFactory,
  type AiClient,
  type AiMessage,
  type AiParams,
} from "../client";
import { aiConfiguredFrom } from "../configured";
import { aiFailure, aiOk, aiUnavailable, withAiClient } from "../respond";

const KEY = "sk-ant-test-secret-123";
const env = (key?: string) => ({ ANTHROPIC_API_KEY: key });

const msg = (p: Partial<AiMessage> = {}): AiMessage =>
  ({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: AI_MODEL,
    content: [{ type: "text", text: '{"ok":1}', citations: null }],
    stop_reason: "end_turn",
    stop_details: null,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
    ...p,
  }) as unknown as AiMessage;

/** Fake client: records every request, answers with `reply` or throws it. */
function fake(reply: AiMessage | Error = msg()) {
  const calls: AiParams[] = [];
  const client: AiClient = {
    createMessage: async (params) => {
      calls.push(params);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  return { client, calls };
}

afterEach(() => setAiClientFactory(null));

describe("aiConfiguredFrom", () => {
  it("is false with no key, a blank key or a placeholder", () => {
    expect(aiConfiguredFrom({})).toBe(false);
    expect(aiConfiguredFrom(env(""))).toBe(false);
    expect(aiConfiguredFrom(env("   "))).toBe(false);
    expect(aiConfiguredFrom(env("YOUR-KEY-HERE"))).toBe(false);
    expect(aiConfiguredFrom(env("your-anthropic-key"))).toBe(false);
  });

  it("is true with a real-looking key", () => {
    expect(aiConfiguredFrom(env(KEY))).toBe(true);
  });

  it("ignores a NEXT_PUBLIC_ copy of the key", () => {
    expect(aiConfiguredFrom({ NEXT_PUBLIC_ANTHROPIC_API_KEY: KEY })).toBe(false);
  });
});

describe("getAiClient", () => {
  it("returns null when not configured and never calls the factory", () => {
    let made = 0;
    setAiClientFactory(() => {
      made++;
      return fake().client;
    });
    expect(getAiClient(env())).toBeNull();
    expect(made).toBe(0);
  });

  it("passes the trimmed key from ANTHROPIC_API_KEY to the factory", () => {
    const seen: string[] = [];
    const { client } = fake();
    setAiClientFactory((k) => {
      seen.push(k);
      return client;
    });
    expect(getAiClient(env(`  ${KEY} `))).toBe(client);
    expect(seen).toEqual([KEY]);
  });

  it("builds a real SDK-backed client by default without any network call", () => {
    const client = sdkClientFactory(KEY);
    expect(typeof client.createMessage).toBe("function");
  });
});

describe("buildParams", () => {
  it("pins the model, cap and refusal fallback", () => {
    const p = buildParams({ messages: [{ role: "user", content: "hi" }] });
    expect(p.model).toBe("claude-sonnet-5-5");
    expect(p.max_tokens).toBe(AI_MAX_TOKENS);
    expect(p.betas).toEqual([AI_FALLBACK_BETA]);
    expect(p.fallbacks).toBe("default");
    expect(p.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("keeps a route's own max_tokens and system prompt", () => {
    const p = buildParams({ system: "coach", max_tokens: 500, messages: [] });
    expect(p.max_tokens).toBe(500);
    expect(p.system).toBe("coach");
  });
});

describe("messageText", () => {
  it("joins text blocks and skips the rest", () => {
    const m = msg({
      content: [
        { type: "thinking", thinking: "", signature: "s" },
        { type: "text", text: "a", citations: null },
        { type: "text", text: "b", citations: null },
      ] as AiMessage["content"],
    });
    expect(messageText(m)).toBe("ab");
  });
});

describe("runAi", () => {
  const req = { messages: [{ role: "user" as const, content: "plan" }] };

  it("is unavailable with no client", async () => {
    expect(await runAi(null, req)).toEqual({ ok: false, reason: "unavailable" });
  });

  it("sends built params and returns the text", async () => {
    const { client, calls } = fake();
    const r = await runAi(client, req);
    expect(r.ok && r.text).toBe('{"ok":1}');
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe(AI_MODEL);
  });

  it("maps refusal and max_tokens stops", async () => {
    expect(await runAi(fake(msg({ stop_reason: "refusal" })).client, req)).toEqual({ ok: false, reason: "refused" });
    expect(await runAi(fake(msg({ stop_reason: "max_tokens" })).client, req)).toEqual({ ok: false, reason: "truncated" });
  });

  it("maps SDK errors to reasons and never throws", async () => {
    const rate = new Anthropic.RateLimitError(429, undefined, "slow down", new Headers());
    const auth = new Anthropic.AuthenticationError(401, undefined, "bad key", new Headers());
    const conn = new Anthropic.APIConnectionError({ message: "offline" });
    const server = new Anthropic.InternalServerError(500, undefined, "boom", new Headers());
    expect(await runAi(fake(rate).client, req)).toEqual({ ok: false, reason: "rate_limited" });
    expect(await runAi(fake(auth).client, req)).toEqual({ ok: false, reason: "unavailable" });
    expect(await runAi(fake(conn).client, req)).toEqual({ ok: false, reason: "unavailable" });
    expect(await runAi(fake(server).client, req)).toEqual({ ok: false, reason: "error" });
    expect(await runAi(fake(new Error("plain")).client, req)).toEqual({ ok: false, reason: "error" });
  });

  it("does not leak an error message that contains the key", async () => {
    const r = await runAi(fake(new Error(`failed with ${KEY}`)).client, req);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });
});

describe("respond helpers", () => {
  it("aiUnavailable is 503 {unavailable:true}", async () => {
    const res = aiUnavailable();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ unavailable: true });
  });

  it("aiFailure maps each reason to a fixed body", async () => {
    expect((await aiFailure("unavailable").json())).toEqual({ unavailable: true });
    const cases = [
      ["rate_limited", 429],
      ["refused", 422],
      ["truncated", 502],
      ["error", 502],
    ] as const;
    for (const [reason, status] of cases) {
      const res = aiFailure(reason);
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error: reason });
    }
  });

  it("aiOk is 200 JSON", async () => {
    const res = aiOk({ days: [] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ days: [] });
  });

  it("withAiClient answers 503 without a key and never runs the handler", async () => {
    let ran = false;
    const res = await withAiClient(async () => {
      ran = true;
      return aiOk({});
    }, env());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ unavailable: true });
    expect(ran).toBe(false);
  });

  it("withAiClient hands the injected client to the handler when configured", async () => {
    const { client, calls } = fake();
    setAiClientFactory(() => client);
    const res = await withAiClient(async (c) => {
      const r = await runAi(c, { messages: [{ role: "user", content: "x" }] });
      return r.ok ? aiOk({ text: r.text }) : aiFailure(r.reason);
    }, env(KEY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: '{"ok":1}' });
    expect(calls).toHaveLength(1);
    const body = JSON.stringify(calls[0]);
    expect(body).not.toContain(KEY);
  });
});
