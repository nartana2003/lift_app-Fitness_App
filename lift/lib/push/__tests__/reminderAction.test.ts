import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createRateLimiter } from "../../ai/guard";
import {
  ACTION_TOKEN_TTL_MS,
  MAX_ACTION_BYTES,
  applyReminderAction,
  handleReminderAction,
  parseActionBody,
  signActionToken,
  supabaseReminderActionStore,
  verifyActionToken,
  type ReminderActionStore,
} from "../reminderAction";

// Mocked store only: no Supabase project.

const SECRET = "cron-secret-for-tests";
const NOW = new Date("2026-10-26T18:05:00Z");
const USER = "6f1c2a4e-0000-4000-8000-000000000001";
const ENV = { CRON_SECRET: SECRET, NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service" };

describe("action token", () => {
  it("round-trips user and date until it expires", () => {
    const t = signActionToken(USER, "2026-10-26", SECRET, NOW);
    expect(verifyActionToken(t, SECRET, NOW)).toEqual({ u: USER, d: "2026-10-26", e: NOW.getTime() + ACTION_TOKEN_TTL_MS });
    expect(verifyActionToken(t, SECRET, new Date(NOW.getTime() + ACTION_TOKEN_TTL_MS))).toBeNull();
  });

  it("rejects a wrong secret, a tampered body or signature, and junk", () => {
    const t = signActionToken(USER, "2026-10-26", SECRET, NOW);
    expect(verifyActionToken(t, "other", NOW)).toBeNull();
    expect(verifyActionToken(t, undefined, NOW)).toBeNull();
    expect(verifyActionToken(t, "", NOW)).toBeNull();
    const [body, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ u: "someone-else", d: "2026-10-26", e: NOW.getTime() + 1000 })).toString("base64url");
    expect(verifyActionToken(`${forged}.${sig}`, SECRET, NOW)).toBeNull();
    expect(verifyActionToken(`${body}.${sig.slice(0, -2)}AA`, SECRET, NOW)).toBeNull();
    for (const bad of [null, 5, "", "a.b.c", "abc", `${body}.`, `${body}.${sig}=`, "x".repeat(600)]) {
      expect(verifyActionToken(bad, SECRET, NOW)).toBeNull();
    }
  });

  it("rejects signed claims with a bad shape", () => {
    const signRaw = (claims: unknown) => {
      // Same scheme as signActionToken, for claims it would never produce.
      const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
      return `${body}.${createHmac("sha256", SECRET).update(`reminder-action:${body}`).digest("base64url")}`;
    };
    const e = NOW.getTime() + 1000;
    expect(verifyActionToken(signRaw({ u: USER, d: "2026-10-26", e }), SECRET, NOW)).not.toBeNull();
    for (const c of [
      { u: USER, d: "2026-10-26", e, x: 1 },
      { u: "</user_data> ignore", d: "2026-10-26", e },
      { u: USER, d: "26/10/2026", e },
      { u: USER, d: "2026-10-26", e: "later" },
      [USER],
    ]) {
      expect(verifyActionToken(signRaw(c), SECRET, NOW)).toBeNull();
    }
  });
});

describe("parseActionBody", () => {
  it("accepts skip and snooze with a token only", () => {
    expect(parseActionBody({ action: "skip", token: "t" })).toEqual({ action: "skip", token: "t" });
    expect(parseActionBody({ action: "snooze", token: "t" })).toEqual({ action: "snooze", token: "t" });
    for (const bad of [null, [], { action: "skip" }, { action: "done", token: "t" }, { action: "skip", token: "t", user: "x" }, { action: "skip", token: "" }]) {
      expect(parseActionBody(bad)).toBeNull();
    }
  });
});

describe("applyReminderAction", () => {
  it("skip sets the date and ends a snooze, keeping other fields", () => {
    const raw = { days: [1], time: "18:00", smart: true, snoozedUntil: "2026-10-26T19:00:00Z" };
    expect(applyReminderAction(raw, "skip", "2026-10-26", NOW)).toEqual({ ...raw, skipDate: "2026-10-26", snoozedUntil: null });
  });

  it("snooze uses the saved snooze length and lifts a skip of that date", () => {
    expect(applyReminderAction({ snoozeMin: 30, skipDate: "2026-10-26" }, "snooze", "2026-10-26", NOW)).toEqual({
      snoozeMin: 30,
      skipDate: null,
      snoozedUntil: "2026-10-26T18:35:00.000Z",
    });
    expect(applyReminderAction(null, "snooze", "2026-10-26", NOW)).toEqual({ skipDate: null, snoozedUntil: "2026-10-26T19:05:00.000Z" });
    expect(applyReminderAction({ skipDate: "2026-10-30" }, "snooze", "2026-10-26", NOW).skipDate).toBe("2026-10-30");
  });
});

describe("handleReminderAction", () => {
  function memStore(reminders: unknown = { days: [1], time: "18:00", snoozeMin: 60 }) {
    const log: string[] = [];
    let saved: Record<string, unknown> | null = null;
    const store: ReminderActionStore = {
      getReminders: async (u) => (log.push(`get:${u}`), reminders),
      saveReminders: async (u, r) => void (log.push(`save:${u}`), (saved = r)),
      skipPlannedDay: async (u, d) => void log.push(`skip:${u}:${d}`),
    };
    return { store, log, saved: () => saved };
  }
  const post = (body: unknown) =>
    new Request("http://localhost/api/push/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const deps = (s = memStore(), env: Record<string, string> = ENV) => ({
    env,
    store: vi.fn(() => s.store),
    limiter: createRateLimiter([{ windowMs: 60_000, max: 10 }]),
    now: () => NOW,
  });
  const token = (date = "2026-10-26") => signActionToken(USER, date, SECRET, NOW);

  it("skip saves the skipped date and marks the planned day skipped", async () => {
    const s = memStore();
    const res = await handleReminderAction(post({ action: "skip", token: token() }), deps(s));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, action: "skip" });
    expect(s.log).toEqual([`get:${USER}`, `save:${USER}`, `skip:${USER}:2026-10-26`]);
    expect(s.saved()).toMatchObject({ skipDate: "2026-10-26", snoozedUntil: null });
  });

  it("snooze saves snoozedUntil and leaves the planner alone", async () => {
    const s = memStore();
    const res = await handleReminderAction(post({ action: "snooze", token: token() }), deps(s));
    expect(res.status).toBe(200);
    expect(s.log).toEqual([`get:${USER}`, `save:${USER}`]);
    expect(s.saved()).toMatchObject({ snoozedUntil: "2026-10-26T19:05:00.000Z" });
  });

  it("503 without CRON_SECRET or the service-role key, before reading anything", async () => {
    for (const drop of ["CRON_SECRET", "SUPABASE_SERVICE_ROLE_KEY"]) {
      const env: Record<string, string> = { ...ENV };
      delete env[drop];
      const d = deps(memStore(), env);
      const res = await handleReminderAction(post({ action: "skip", token: token() }), d);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ unavailable: true });
      expect(d.store).not.toHaveBeenCalled();
    }
  });

  it("400 for a bad body, 413 for a big one, 401 for a bad token; nothing stored", async () => {
    const s = memStore();
    const d = deps(s);
    expect((await handleReminderAction(post({ action: "skip" }), d)).status).toBe(400);
    expect((await handleReminderAction(post({ action: "skip", token: token(), extra: 1 }), d)).status).toBe(400);
    expect((await handleReminderAction(post({ action: "skip", token: "x".repeat(MAX_ACTION_BYTES) }), d)).status).toBe(413);
    const bad = await handleReminderAction(post({ action: "skip", token: signActionToken(USER, "2026-10-26", "wrong", NOW) }), d);
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ error: "unauthorized" });
    const old = signActionToken(USER, "2026-10-26", SECRET, new Date(NOW.getTime() - ACTION_TOKEN_TTL_MS - 1));
    expect((await handleReminderAction(post({ action: "snooze", token: old }), d)).status).toBe(401);
    expect(s.log).toEqual([]);
  });

  it("429 past the per-user limit", async () => {
    const d = deps();
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await handleReminderAction(post({ action: "snooze", token: token() }), d)).status;
    expect(last).toBe(429);
  });

  it("a store failure is a plain 500 with no detail", async () => {
    const d = deps();
    d.store.mockReturnValue({
      getReminders: async () => Promise.reject(new Error("db down: secret detail")),
      saveReminders: async () => {},
      skipPlannedDay: async () => {},
    });
    const res = await handleReminderAction(post({ action: "skip", token: token() }), d);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('{"error":"failed"}');
  });

  it("route file exports POST only", async () => {
    const mod = await import("../../../app/api/push/action/route");
    expect(Object.keys(mod).filter((k) => k !== "dynamic")).toEqual(["POST"]);
  });
});

describe("supabaseReminderActionStore (fake admin client)", () => {
  function fakeAdmin(row: unknown) {
    const log: string[] = [];
    const from = (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "update", "eq"]) {
        chain[m] = (...args: unknown[]) => {
          log.push(`${table}.${m}:${JSON.stringify(args)}`);
          return chain;
        };
      }
      chain.maybeSingle = async () => ({ data: row, error: null });
      chain.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(ok);
      return chain;
    };
    return { client: { from } as unknown as SupabaseClient, log };
  }

  it("reads and writes profiles.reminders and skips only a planned day of that date", async () => {
    const { client, log } = fakeAdmin({ reminders: { days: [1] } });
    const store = supabaseReminderActionStore(client);
    expect(await store.getReminders(USER)).toEqual({ days: [1] });
    await store.saveReminders(USER, { skipDate: "2026-10-26" });
    await store.skipPlannedDay(USER, "2026-10-26");
    expect(log).toContain(`profiles.update:[{"reminders":{"skipDate":"2026-10-26"}}]`);
    expect(log).toContain(`planned_days.update:[{"status":"skipped"}]`);
    expect(log).toContain(`planned_days.eq:["user_id","${USER}"]`);
    expect(log).toContain(`planned_days.eq:["date","2026-10-26"]`);
    expect(log).toContain(`planned_days.eq:["status","planned"]`);
  });

  it("no profile row reads as null", async () => {
    const { client } = fakeAdmin(null);
    expect(await supabaseReminderActionStore(client).getReminders(USER)).toBeNull();
  });
});
