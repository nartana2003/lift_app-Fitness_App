import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { handleReminderCron, MAX_SENDS_PER_RUN, runReminderJob, supabaseReminderStore, type ReminderStore, type ReminderTarget } from "../reminderJob";
import type { PushSender } from "../send";
import type { PushSub } from "../endpoint";

// Mocked store and sender only: no Supabase project, no real push.

const P256 = "B" + "A".repeat(86);
const AUTH = "a".repeat(22);
const sub = (n: number): PushSub => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, keys: { p256dh: P256, auth: AUTH } });
const NOW = new Date("2026-10-26T18:05:00Z"); // Monday

const target = (o: Partial<ReminderTarget> = {}): ReminderTarget => ({
  userId: "u1",
  timezone: "UTC",
  reminders: { days: [1], time: "18:00" },
  gymDates: [],
  subscriptions: [sub(1)],
  ...o,
});

function memStore(targets: ReminderTarget[]) {
  const removed: string[] = [];
  const store: ReminderStore = {
    loadTargets: async () => targets,
    removeSubscription: async (e) => void removed.push(e),
  };
  return { store, removed };
}

describe("runReminderJob", () => {
  it("sends the reminder to every subscription of a due user only", async () => {
    const { store } = memStore([
      target({ subscriptions: [sub(1), sub(2)] }),
      target({ userId: "u2", reminders: { days: [2], time: "18:00" }, subscriptions: [sub(3)] }),
    ]);
    const sent: { endpoint: string; payload: unknown }[] = [];
    const send: PushSender = async (s, p) => {
      sent.push({ endpoint: s.endpoint, payload: JSON.parse(p) });
      return { ok: true };
    };
    expect(await runReminderJob(store, send, NOW)).toEqual({ users: 2, due: 1, sent: 2, failed: 0, removed: 0 });
    expect(sent.map((s) => s.endpoint)).toEqual([sub(1).endpoint, sub(2).endpoint]);
    expect(sent[0].payload).toMatchObject({ title: "Lift", tag: "lift-reminder-2026-10-26", url: "/" });
  });

  it("uses marked gym dates", async () => {
    const { store } = memStore([target({ reminders: { days: [], time: "18:00" }, gymDates: ["2026-10-26"] })]);
    expect((await runReminderJob(store, async () => ({ ok: true }), NOW)).sent).toBe(1);
  });

  it("removes gone subscriptions and counts failures; a throwing sender does not stop the run", async () => {
    const { store, removed } = memStore([target({ subscriptions: [sub(1), sub(2), sub(3)] })]);
    const send: PushSender = async (s) => {
      if (s.endpoint.endsWith("/1")) return { ok: false, gone: true };
      if (s.endpoint.endsWith("/2")) throw new Error("network");
      return { ok: true };
    };
    expect(await runReminderJob(store, send, NOW)).toEqual({ users: 1, due: 1, sent: 1, failed: 2, removed: 1 });
    expect(removed).toEqual([sub(1).endpoint]);
  });

  it("caps sends per run", async () => {
    const subs = Array.from({ length: MAX_SENDS_PER_RUN + 5 }, (_, i) => sub(i));
    const { store } = memStore([target({ subscriptions: subs })]);
    const send = vi.fn<PushSender>(async () => ({ ok: true }));
    await runReminderJob(store, send, NOW);
    expect(send).toHaveBeenCalledTimes(MAX_SENDS_PER_RUN);
  });
});

describe("handleReminderCron", () => {
  const SECRET = "cron-secret-for-tests";
  const ENV = {
    CRON_SECRET: SECRET,
    NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service",
    NEXT_PUBLIC_VAPID_PUBLIC_KEY: "pub",
    VAPID_PRIVATE_KEY: "priv",
    VAPID_SUBJECT: "mailto:a@b.c",
  };
  const req = (auth?: string) => new Request("http://localhost/api/cron/reminders", auth ? { headers: { authorization: auth } } : undefined);
  const deps = (env: Record<string, string> = ENV) => {
    const store = vi.fn(() => memStore([target()]).store);
    const send = vi.fn(() => (async () => ({ ok: true })) as PushSender);
    return { env, store, send, now: () => NOW };
  };

  it("401 without the bearer secret, before touching anything", async () => {
    for (const a of [undefined, "Bearer wrong", SECRET]) {
      const d = deps();
      const res = await handleReminderCron(req(a), d);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
      expect(d.store).not.toHaveBeenCalled();
    }
    const d = deps({ ...ENV, CRON_SECRET: "" });
    expect((await handleReminderCron(req("Bearer "), d)).status).toBe(401);
  });

  it("503 unavailable when VAPID or the service-role key is missing", async () => {
    for (const drop of ["VAPID_PRIVATE_KEY", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_VAPID_PUBLIC_KEY"]) {
      const env: Record<string, string> = { ...ENV };
      delete env[drop];
      const d = deps(env);
      const res = await handleReminderCron(req(`Bearer ${SECRET}`), d);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ unavailable: true });
      expect(d.store).not.toHaveBeenCalled();
    }
  });

  it("runs the job and returns counts; a store failure is a plain 500", async () => {
    const res = await handleReminderCron(req(`Bearer ${SECRET}`), deps());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ users: 1, due: 1, sent: 1, failed: 0, removed: 0 });

    const d = deps();
    d.store.mockReturnValue({ loadTargets: async () => Promise.reject(new Error("db down: secret detail")), removeSubscription: async () => {} });
    const bad = await handleReminderCron(req(`Bearer ${SECRET}`), d);
    expect(bad.status).toBe(500);
    expect(await bad.text()).not.toContain("secret detail");
  });
});

describe("supabaseReminderStore (fake admin client)", () => {
  type Q = { table: string; filters: string[] };
  function fakeAdmin(data: Record<string, unknown[]>) {
    const log: Q[] = [];
    const deleted: string[] = [];
    const from = (table: string) => {
      const q: Q = { table, filters: [] };
      log.push(q);
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "in", "eq", "gte", "lte", "limit"]) {
        chain[m] = (...args: unknown[]) => {
          q.filters.push(`${m}:${JSON.stringify(args)}`);
          return chain;
        };
      }
      chain.delete = () => ({
        eq: async (_c: string, v: string) => {
          deleted.push(v);
          return { error: null };
        },
      });
      chain.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: data[table] ?? [], error: null }).then(ok);
      return chain;
    };
    return { client: { from } as unknown as SupabaseClient, log, deleted };
  }

  it("groups valid subscriptions by user with profile and planned dates", async () => {
    const { client, log } = fakeAdmin({
      push_subscriptions: [
        { user_id: "u1", endpoint: sub(1).endpoint, keys: sub(1).keys },
        { user_id: "u1", endpoint: "https://evil.example/x", keys: sub(1).keys },
        { user_id: "u2", endpoint: sub(2).endpoint, keys: { p256dh: "bad", auth: AUTH } },
      ],
      profiles: [{ id: "u1", timezone: "Europe/Berlin", reminders: { days: [1] } }],
      planned_days: [{ user_id: "u1", date: "2026-10-27" }],
    });
    const targets = await supabaseReminderStore(client).loadTargets(NOW);
    expect(targets).toEqual([
      { userId: "u1", timezone: "Europe/Berlin", reminders: { days: [1] }, gymDates: ["2026-10-27"], subscriptions: [sub(1)] },
    ]);
    const planned = log.find((q) => q.table === "planned_days")!;
    expect(planned.filters).toContain('eq:["status","planned"]');
    expect(planned.filters).toContain('gte:["date","2026-10-24"]');
    expect(planned.filters).toContain('lte:["date","2026-10-28"]');
  });

  it("no subscriptions, no further queries", async () => {
    const { client, log } = fakeAdmin({});
    expect(await supabaseReminderStore(client).loadTargets(NOW)).toEqual([]);
    expect(log.map((q) => q.table)).toEqual(["push_subscriptions"]);
  });

  it("removes by endpoint", async () => {
    const { client, deleted } = fakeAdmin({});
    await supabaseReminderStore(client).removeSubscription(sub(1).endpoint);
    expect(deleted).toEqual([sub(1).endpoint]);
  });
});
