import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  actionSigner,
  handleReminderCron,
  runReminderJob,
  supabaseNudgeStore,
  type NudgeStore,
  type ReminderStore,
  type ReminderTarget,
} from "../reminderJob";
import type { NudgeData } from "../nudges";
import { verifyActionToken } from "../reminderAction";
import type { PushSender } from "../send";
import type { PushSub } from "../endpoint";

// REM-03: nudges and Skip / Snooze buttons. Mocked store and sender only.

const P256 = "B" + "A".repeat(86);
const AUTH = "a".repeat(22);
const sub = (n: number): PushSub => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, keys: { p256dh: P256, auth: AUTH } });
const SECRET = "cron-secret-for-tests";
const THU = new Date("2026-10-29T18:05:00Z"); // Thursday

const target = (o: Partial<ReminderTarget> = {}): ReminderTarget => ({
  userId: "u1",
  timezone: "UTC",
  reminders: { days: [4], time: "18:00", smart: true, behindNudge: true, snoozeMin: 30 },
  gymDates: [],
  subscriptions: [sub(1)],
  ...o,
});
const store = (targets: ReminderTarget[]): ReminderStore => ({ loadTargets: async () => targets, removeSubscription: async () => {} });
const nudges = (data: Record<string, NudgeData>): NudgeStore => ({ loadNudgeData: async () => new Map(Object.entries(data)) });
const capture = () => {
  const sent: { endpoint: string; payload: Record<string, unknown> }[] = [];
  const send: PushSender = async (s, p) => (sent.push({ endpoint: s.endpoint, payload: JSON.parse(p) }), { ok: true });
  return { sent, send };
};
const muscleOf = (id: string) => (id === "curl" ? ["Biceps"] : []);
const usual17 = Array.from({ length: 5 }, (_, i) => `2026-10-1${i}T17:00:00Z`);

describe("runReminderJob with extras", () => {
  it("without extras nothing changes: gym reminder only, no buttons", async () => {
    const { sent, send } = capture();
    expect(await runReminderJob(store([target()]), send, THU)).toEqual({ users: 1, due: 1, sent: 1, failed: 0, removed: 0 });
    expect(sent[0].payload).toEqual({ title: "Lift", body: "Gym day today. Your workout is ready when you are.", url: "/", tag: "lift-reminder-2026-10-29", kind: "reminder" });
  });

  it("sends gym reminder, haven't gone yet and behind, with buttons on the planned-day ones", async () => {
    const { sent, send } = capture();
    const data = { workoutStarts: usual17, weekSets: [], targets: { Biceps: 6 } };
    const r = await runReminderJob(store([target()]), send, THU, 60, {
      nudges: nudges({ u1: data }),
      muscleOf,
      signAction: actionSigner(SECRET, THU),
    });
    expect(r).toEqual({ users: 1, due: 3, sent: 3, failed: 0, removed: 0 });
    expect(sent.map((s) => s.payload.tag)).toEqual(["lift-reminder-2026-10-29", "lift-not-yet-2026-10-29", "lift-behind-2026-10-29"]);
    const [gym, notYet, behind] = sent.map((s) => s.payload);
    expect(gym.actions).toEqual([
      { action: "skip", title: "Skip today" },
      { action: "snooze", title: "Snooze 30 min" },
    ]);
    expect(verifyActionToken(gym.token, SECRET, THU)).toMatchObject({ u: "u1", d: "2026-10-29" });
    expect(notYet.body).toBe("You usually train at 17:00 and haven't gone yet today.");
    expect(notYet.actions).toBeDefined();
    expect(behind.body).toBe("You're behind on your weekly goal: 6 sets left across 1 muscle.");
    expect(behind.actions).toBeUndefined();
    expect(behind.token).toBeUndefined();
  });

  it("no behind nudge without muscleOf; nudge-store failure still sends the gym reminder", async () => {
    const data = { workoutStarts: ["2026-10-29T06:00:00Z", ...usual17], weekSets: [], targets: { Biceps: 6 } };
    const a = capture();
    await runReminderJob(store([target()]), a.send, THU, 60, { nudges: nudges({ u1: data }) });
    expect(a.sent.map((s) => s.payload.tag)).toEqual(["lift-reminder-2026-10-29"]);

    const b = capture();
    const broken: NudgeStore = { loadNudgeData: async () => Promise.reject(new Error("db down")) };
    expect((await runReminderJob(store([target()]), b.send, THU, 60, { nudges: broken, muscleOf })).sent).toBe(1);
  });

  it("a subscription reported gone is not sent the next message", async () => {
    const removed: string[] = [];
    const st: ReminderStore = { loadTargets: async () => [target({ subscriptions: [sub(1), sub(2)] })], removeSubscription: async (e) => void removed.push(e) };
    const send = vi.fn<PushSender>(async (s) => (s.endpoint.endsWith("/1") ? { ok: false, gone: true } : { ok: true }));
    const data = { workoutStarts: usual17, weekSets: [], targets: { Biceps: 6 } };
    const r = await runReminderJob(st, send, THU, 60, { nudges: nudges({ u1: data }), muscleOf });
    expect(r).toEqual({ users: 1, due: 3, sent: 3, failed: 1, removed: 1 });
    expect(removed).toEqual([sub(1).endpoint]);
  });
});

describe("handleReminderCron extras", () => {
  const ENV = {
    CRON_SECRET: SECRET,
    NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service",
    NEXT_PUBLIC_VAPID_PUBLIC_KEY: "pub",
    VAPID_PRIVATE_KEY: "priv",
    VAPID_SUBJECT: "mailto:a@b.c",
  };
  const req = (auth?: string) => new Request("http://localhost/api/cron/reminders", auth ? { headers: { authorization: auth } } : undefined);

  it("passes extras to the job, and never builds them before the secret check", async () => {
    const extras = vi.fn(() => ({ nudges: nudges({ u1: { workoutStarts: usual17, weekSets: [], targets: {} } }) }));
    const deps = { env: ENV, store: () => store([target()]), send: () => capture().send, now: () => THU, extras };
    expect((await handleReminderCron(req("Bearer wrong"), deps)).status).toBe(401);
    expect(extras).not.toHaveBeenCalled();
    const res = await handleReminderCron(req(`Bearer ${SECRET}`), deps);
    expect(await res.json()).toEqual({ users: 1, due: 2, sent: 2, failed: 0, removed: 0 });
  });
});

describe("supabaseNudgeStore (fake admin client)", () => {
  function fakeAdmin(data: Record<string, unknown[]>) {
    const tables: string[] = [];
    const from = (table: string) => {
      tables.push(table);
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "in", "eq", "gte", "order", "limit"]) chain[m] = () => chain;
      chain.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: data[table] ?? [], error: null }).then(ok);
      return chain;
    };
    return { client: { from } as unknown as SupabaseClient, tables };
  }

  it("groups starts, this week's sets and targets per user", async () => {
    const { client } = fakeAdmin({
      workouts: [
        { id: "w1", user_id: "u1", started_at: "2026-10-27T17:00:00Z" },
        { id: "w0", user_id: "u1", started_at: "2026-10-01T17:00:00Z" },
        { id: "w2", user_id: "u2", started_at: "2026-10-28T07:00:00Z" },
        { id: 5, user_id: "u1", started_at: "x" },
      ],
      muscle_targets: [
        { user_id: "u1", muscle_group: "Biceps", weekly_sets: 8 },
        { user_id: "u1", muscle_group: "Chest", weekly_sets: "lots" },
      ],
      workout_exercises: [
        { id: "we1", workout_id: "w1", exercise_id: "curl" },
        { id: "we0", workout_id: "w0", exercise_id: "curl" },
        { id: "we2", workout_id: "w2", exercise_id: "squat" },
      ],
      sets: [
        { workout_exercise_id: "we1", is_warmup: false },
        { workout_exercise_id: "we1", is_warmup: true },
        { workout_exercise_id: "we0", is_warmup: false },
        { workout_exercise_id: "we2", is_warmup: false },
      ],
    });
    const out = await supabaseNudgeStore(client).loadNudgeData(["u1", "u2", "u3"], THU);
    expect(out.get("u1")).toEqual({
      workoutStarts: ["2026-10-27T17:00:00Z", "2026-10-01T17:00:00Z"],
      weekSets: [
        { started_at: "2026-10-27T17:00:00Z", exercise_id: "curl", is_warmup: false },
        { started_at: "2026-10-27T17:00:00Z", exercise_id: "curl", is_warmup: true },
      ],
      targets: { Biceps: 8 },
    });
    expect(out.get("u2")?.weekSets).toEqual([{ started_at: "2026-10-28T07:00:00Z", exercise_id: "squat", is_warmup: false }]);
    expect(out.get("u3")).toEqual({ workoutStarts: [], weekSets: [], targets: {} });
  });

  it("no workouts this week: no exercise or set queries", async () => {
    const { client, tables } = fakeAdmin({});
    await supabaseNudgeStore(client).loadNudgeData(["u1"], THU);
    expect(tables).toEqual(["workouts", "muscle_targets"]);
  });
});
