import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createRateLimiter } from "../../ai/guard";
import {
  handlePushSubscription,
  MAX_SUBSCRIBE_BYTES,
  MAX_SUBSCRIPTIONS_PER_USER,
  parseSubscribeBody,
  parseUnsubscribeBody,
  supabaseSubscriptionStore,
  type SubscribeDeps,
  type SubscriptionStore,
} from "../subscribe";

// Mocked user lookup and store: no Supabase project.

const P256 = "B" + "A".repeat(86);
const AUTH = "a".repeat(22);
const EP = "https://fcm.googleapis.com/fcm/send/abc";
const BODY = { endpoint: EP, expirationTime: null, keys: { p256dh: P256, auth: AUTH } };
const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: "pub",
  VAPID_PRIVATE_KEY: "priv",
  VAPID_SUBJECT: "mailto:a@b.c",
};

function setup(o: Partial<SubscribeDeps> = {}) {
  const saved: [string, unknown][] = [];
  const removed: [string, string][] = [];
  const store: SubscriptionStore = {
    save: async (u, s) => void saved.push([u, s]),
    remove: async (u, e) => void removed.push([u, e]),
  };
  const deps: SubscribeDeps = {
    env: ENV,
    resolveUser: async () => ({ id: "u1" }),
    store: () => store,
    limiter: createRateLimiter([{ windowMs: 60_000, max: 100 }]),
    ...o,
  };
  return { deps, saved, removed };
}

const req = (method: "POST" | "DELETE", body: unknown) =>
  new Request("http://localhost/api/push/subscribe", { method, body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("parse bodies", () => {
  it("accepts PushSubscription.toJSON() and rejects extras", () => {
    expect(parseSubscribeBody(BODY)).toEqual({ endpoint: EP, keys: { p256dh: P256, auth: AUTH } });
    expect(parseSubscribeBody({ ...BODY, expirationTime: 123 })).not.toBeNull();
    expect(parseSubscribeBody({ ...BODY, expirationTime: "soon" })).toBeNull();
    expect(parseSubscribeBody({ ...BODY, user_id: "someone-else" })).toBeNull();
    expect(parseSubscribeBody({ ...BODY, endpoint: "http://169.254.169.254/" })).toBeNull();
    expect(parseUnsubscribeBody({ endpoint: EP })).toBe(EP);
    expect(parseUnsubscribeBody({ endpoint: EP, x: 1 })).toBeNull();
    expect(parseUnsubscribeBody({ endpoint: "https://evil.example" })).toBeNull();
  });
});

describe("handlePushSubscription", () => {
  it("saves for the signed-in user", async () => {
    const { deps, saved } = setup();
    const res = await handlePushSubscription(req("POST", BODY), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(saved).toEqual([["u1", { endpoint: EP, keys: { p256dh: P256, auth: AUTH } }]]);
  });

  it("removes on DELETE, scoped to the user", async () => {
    const { deps, removed } = setup();
    expect((await handlePushSubscription(req("DELETE", { endpoint: EP }), deps)).status).toBe(200);
    expect(removed).toEqual([["u1", EP]]);
  });

  it("503 when Supabase, the service role or VAPID is missing", async () => {
    for (const drop of ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "VAPID_PRIVATE_KEY"]) {
      const env: Record<string, string> = { ...ENV };
      delete env[drop];
      const resolveUser = vi.fn(async () => ({ id: "u1" }));
      const { deps } = setup({ env, resolveUser });
      const res = await handlePushSubscription(req("POST", BODY), deps);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ unavailable: true });
      expect(resolveUser).not.toHaveBeenCalled();
    }
  });

  it("401 when signed out or the lookup throws, before the body is read", async () => {
    for (const resolveUser of [async () => null, async () => ({ id: " " }), async () => Promise.reject(new Error("x"))]) {
      const { deps, saved } = setup({ resolveUser });
      const r = req("POST", BODY);
      const res = await handlePushSubscription(r, deps);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
      expect(r.bodyUsed).toBe(false);
      expect(saved).toEqual([]);
    }
  });

  it("429 over the per-user limit", async () => {
    const { deps } = setup({ limiter: createRateLimiter([{ windowMs: 60_000, max: 1 }]) });
    expect((await handlePushSubscription(req("POST", BODY), deps)).status).toBe(200);
    const res = await handlePushSubscription(req("POST", BODY), deps);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  it("400 for bad JSON or shape, 413 over the byte cap", async () => {
    const { deps, saved } = setup();
    expect((await handlePushSubscription(req("POST", "{not json"), deps)).status).toBe(400);
    expect((await handlePushSubscription(req("POST", { endpoint: EP }), deps)).status).toBe(400);
    expect((await handlePushSubscription(req("POST", { ...BODY, endpoint: "https://evil.example/</x>" }), deps)).status).toBe(400);
    expect((await handlePushSubscription(req("POST", { ...BODY, pad: "x".repeat(MAX_SUBSCRIBE_BYTES) }), deps)).status).toBe(413);
    expect(saved).toEqual([]);
  });

  it("store errors are a plain 500 with no detail", async () => {
    const { deps } = setup({ store: () => ({ save: async () => Promise.reject(new Error("db secret")), remove: async () => {} }) });
    const res = await handlePushSubscription(req("POST", BODY), deps);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("db secret");
  });
});

describe("supabaseSubscriptionStore (fake admin client)", () => {
  function fakeAdmin(existing: { id: string }[]) {
    const ops: string[] = [];
    const from = (table: string) => ({
      delete: () => {
        const filters: string[] = [];
        const chain = {
          eq: (c: string, v: string) => {
            filters.push(`${c}=${v}`);
            return chain;
          },
          in: (c: string, v: string[]) => {
            filters.push(`${c} in ${v.join(",")}`);
            return chain;
          },
          then: (ok: (v: unknown) => unknown) => {
            ops.push(`delete ${table} ${filters.join(" & ")}`);
            return Promise.resolve({ error: null }).then(ok);
          },
        };
        return chain;
      },
      insert: async (row: Record<string, unknown>) => {
        ops.push(`insert ${table} ${row.user_id} ${row.endpoint}`);
        return { error: null };
      },
      select: () => ({ eq: () => ({ order: async () => ({ data: existing, error: null }) }) }),
    });
    return { client: { from } as unknown as SupabaseClient, ops };
  }

  it("replaces the endpoint's old row, inserts, and trims old phones", async () => {
    const rows = Array.from({ length: MAX_SUBSCRIPTIONS_PER_USER + 2 }, (_, i) => ({ id: `s${i}` }));
    const { client, ops } = fakeAdmin(rows);
    await supabaseSubscriptionStore(client).save("u1", { endpoint: EP, keys: { p256dh: P256, auth: AUTH } });
    expect(ops).toEqual([
      `delete push_subscriptions endpoint=${EP}`,
      `insert push_subscriptions u1 ${EP}`,
      `delete push_subscriptions id in s${MAX_SUBSCRIPTIONS_PER_USER},s${MAX_SUBSCRIPTIONS_PER_USER + 1}`,
    ]);
  });

  it("remove is scoped to the user", async () => {
    const { client, ops } = fakeAdmin([]);
    await supabaseSubscriptionStore(client).remove("u1", EP);
    expect(ops).toEqual([`delete push_subscriptions endpoint=${EP} & user_id=u1`]);
  });
});
