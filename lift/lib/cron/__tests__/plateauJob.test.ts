import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiClient, AiMessage, AiParams } from "../../ai/client";
import type { Exercise } from "../../exercises";
import type { Equipment, MuscleGroup } from "../../muscles";
import type { HistorySession } from "../../ai/plateau-fix";
import { MAX_AI_CALLS_PER_RUN, type SetFact } from "../job";
import { runPlateauJob, sessionsFromFacts, supabasePlateauStore, type PlateauRow, type PlateauStore, type PlateauUser } from "../plateauJob";
import { GET } from "../../../app/api/cron/plateaus/route";
import { fakeAdmin } from "./fakeAdmin";

// Mocked store, admin client and AI client only.

const ex = (id: string, muscles: MuscleGroup[], equipment: Equipment = "Barbell"): Exercise => ({
  id,
  name: id.replace(/_/g, " "),
  muscle_groups: muscles,
  secondary_groups: [],
  equipment,
  category: "strength",
  mechanic: "compound",
  force: "push",
  level: "beginner",
  instructions: [],
  image_urls: [],
  tiktok_url: "",
});
const CAT: Exercise[] = [ex("bench", ["Chest"]), ex("db_press", ["Chest"], "Dumbbell"), ex("incline_bench", ["Chest"]), ex("squat", ["Quads"])];

const NOW = new Date("2026-11-02T05:00:00Z");
const day = (d: number) => new Date(NOW.getTime() - d * 864e5).toISOString().slice(0, 10);
const sess = (date: string, weight: number, reps = 5): HistorySession => ({ date, sets: [{ reps, weight }, { reps, weight }, { reps, weight }] });
/** Best 5 weeks ago, flat since, last session 2 days ago. */
const stalled = () => [sess(day(35), 100), sess(day(21), 100), sess(day(10), 100), sess(day(2), 100)];
/** Climbing every session. */
const rising = () => [sess(day(35), 90), sess(day(21), 95), sess(day(10), 100), sess(day(2), 105)];

const user = (o: Partial<PlateauUser> = {}): PlateauUser => ({
  userId: "u1",
  goalType: null,
  equipment: [],
  histories: new Map([["bench", stalled()]]),
  openIds: new Set(),
  ...o,
});

function memStore(users: PlateauUser[]) {
  const saved: PlateauRow[] = [];
  const store: PlateauStore = { loadUsers: async () => users, savePlateau: async (r) => void saved.push(r) };
  return { store, saved };
}

const msg = (text: string) =>
  ({ id: "m", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text, citations: null }], stop_reason: "end_turn", stop_details: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }) as unknown as AiMessage;

function fakeAi(text: string) {
  const calls: AiParams[] = [];
  const client: AiClient = { createMessage: async (p) => (calls.push(p), msg(text)) };
  return { client, calls };
}

const AI_FIX = JSON.stringify({ kind: "extra_set", reason: "Flat for five weeks, so add a set.", rep_min: null, rep_max: null, swap_exercise_id: null, extra_sets: 2, deload_percent: null, duration_weeks: 3 });

describe("runPlateauJob", () => {
  it("stores the rule fix for a stalled lift when there is no AI client", async () => {
    const { store, saved } = memStore([user({ histories: new Map([["bench", stalled()], ["squat", rising()]]) })]);
    const out = await runPlateauJob(store, null, CAT, NOW);
    expect(out).toEqual({ users: 1, saved: 1, ai: 0, rule: 1, skipped: 0, failed: 0 });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ user_id: "u1", exercise_id: "bench", weeks_stalled: 4, source: "rule" });
    expect(saved[0].fix.kind).toBe("rep_range");
    expect(saved[0].suggestion).toBe(saved[0].fix.reason);
  });

  it("uses the model's fix when a client is given", async () => {
    const { client, calls } = fakeAi(AI_FIX);
    const { store, saved } = memStore([user()]);
    const out = await runPlateauJob(store, client, CAT, NOW);
    expect(out.ai).toBe(1);
    expect(calls).toHaveLength(1);
    expect(saved[0]).toMatchObject({ source: "ai", suggestion: "Flat for five weeks, so add a set." });
    expect(saved[0].fix.extra_sets).toBe(2);
  });

  it("falls back to the rule fix on malformed model output or a failed call", async () => {
    const { client } = fakeAi("not json");
    const { store, saved } = memStore([user()]);
    expect((await runPlateauJob(store, client, CAT, NOW)).rule).toBe(1);
    expect(saved[0].source).toBe("rule");

    const failing: AiClient = { createMessage: async () => { throw new Error("boom"); } };
    const second = memStore([user()]);
    expect((await runPlateauJob(second.store, failing, CAT, NOW)).rule).toBe(1);
  });

  it("clamps a model swap to the offered candidates (rule fix otherwise)", async () => {
    const { client } = fakeAi(JSON.stringify({ ...JSON.parse(AI_FIX), kind: "swap", swap_exercise_id: "squat", extra_sets: null }));
    const { store, saved } = memStore([user()]);
    await runPlateauJob(store, client, CAT, NOW);
    expect(saved[0].source).toBe("rule");
    expect(saved[0].fix.swap_exercise_id).toBeNull();
  });

  it("skips lifts with an open plateau, lifts not done lately, and ids outside the catalogue", async () => {
    const old = [sess(day(80), 100), sess(day(70), 100), sess(day(60), 100), sess(day(50), 100)];
    const { store, saved } = memStore([
      user({ openIds: new Set(["bench"]) }),
      user({ userId: "u2", histories: new Map([["bench", old], ["custom_lift", stalled()]]) }),
    ]);
    const out = await runPlateauJob(store, null, CAT, NOW);
    expect(out).toMatchObject({ users: 2, saved: 0, skipped: 1 });
    expect(saved).toEqual([]);
  });

  it("stops calling the model once the run budget is used", async () => {
    const { client, calls } = fakeAi(AI_FIX);
    const users = Array.from({ length: MAX_AI_CALLS_PER_RUN + 3 }, (_, i) => user({ userId: `u${i}` }));
    const out = await runPlateauJob(memStore(users).store, client, CAT, NOW);
    expect(calls).toHaveLength(MAX_AI_CALLS_PER_RUN);
    expect(out).toMatchObject({ ai: MAX_AI_CALLS_PER_RUN, rule: 3 });
  });

  it("counts a failed save and keeps going", async () => {
    let n = 0;
    const store: PlateauStore = {
      loadUsers: async () => [user(), user({ userId: "u2" })],
      savePlateau: async () => {
        if (n++ === 0) throw new Error("db");
      },
    };
    expect(await runPlateauJob(store, null, CAT, NOW)).toMatchObject({ saved: 1, failed: 1 });
  });
});

describe("sessionsFromFacts", () => {
  const f = (o: Partial<SetFact>): SetFact => ({ user_id: "u1", workout_id: "w1", started_at: "2026-10-01T10:00:00.000Z", exercise_id: "bench", reps: 5, weight: 100, is_warmup: false, muscle_groups: ["Chest"], ...o });

  it("groups sets per user, exercise and workout, keeping warm-up flags", () => {
    const out = sessionsFromFacts([f({}), f({ is_warmup: true, reps: 10, weight: 40 }), f({ workout_id: "w2", started_at: "2026-10-05T10:00:00.000Z" }), f({ user_id: "u2" })]);
    expect(out.get("u1")!.get("bench")).toEqual([
      { date: "2026-10-01", sets: [{ reps: 5, weight: 100 }, { reps: 10, weight: 40, is_warmup: true }] },
      { date: "2026-10-05", sets: [{ reps: 5, weight: 100 }] },
    ]);
    expect(out.get("u2")!.get("bench")).toHaveLength(1);
  });

  it("drops out-of-range sets and caps sets per session", () => {
    const many = Array.from({ length: 30 }, () => f({}));
    const out = sessionsFromFacts([...many, f({ reps: 2.5 }), f({ weight: -1 }), f({ weight: 5000 })]);
    expect(out.get("u1")!.get("bench")![0].sets).toHaveLength(15);
  });
});

describe("supabasePlateauStore", () => {
  const facts = (userId: string, exerciseId: string) =>
    [35, 21, 10, 2].flatMap((d, i) =>
      [0, 1, 2].map((s) => ({ set_id: `${userId}-${exerciseId}-${i}-${s}`, user_id: userId, workout_id: `${userId}-w${i}`, started_at: new Date(NOW.getTime() - d * 864e5).toISOString(), exercise_id: exerciseId, reps: 5, weight: 100, is_warmup: false, muscle_groups: ["Chest"] })),
    );

  it("loads histories, goals, equipment and open plateaus, then inserts open rows", async () => {
    const { admin, inserted } = fakeAdmin({
      set_facts: [...facts("u1", "bench"), ...facts("u2", "bench")],
      goals: [{ user_id: "u1", goal_type: "strength" }, { user_id: "u2", goal_type: "</user_data>" }],
      user_equipment: [{ user_id: "u1", equipment: ["Dumbbell", "Barbell"] }, { user_id: "u2", equipment: ["Laser"] }],
      plateaus: [{ id: "p1", user_id: "u2", exercise_id: "bench", status: "open" }, { id: "p2", user_id: "u1", exercise_id: "bench", status: "dismissed" }],
    });
    const store = supabasePlateauStore(admin);
    const users = await store.loadUsers(NOW);
    expect(users.map((u) => [u.userId, u.goalType, u.equipment, [...u.openIds]])).toEqual([
      ["u1", "strength", ["Dumbbell", "Barbell"], []],
      ["u2", null, [], ["bench"]],
    ]);
    expect(users[0].histories.get("bench")).toHaveLength(4);

    const out = await runPlateauJob(store, null, CAT, NOW);
    expect(out).toMatchObject({ users: 2, saved: 1, skipped: 1 });
    expect(inserted.plateaus).toEqual([expect.objectContaining({ user_id: "u1", exercise_id: "bench", status: "open", source: "rule" })]);
  });

  it("returns no users when nobody trained", async () => {
    expect(await supabasePlateauStore(fakeAdmin({}).admin).loadUsers(NOW)).toEqual([]);
  });
});

describe("GET /api/cron/plateaus", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("answers 401 without the secret and 503 without the service-role key", async () => {
    vi.stubEnv("CRON_SECRET", "c".repeat(32));
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect((await GET(new Request("http://localhost/api/cron/plateaus"))).status).toBe(401);
    const res = await GET(new Request("http://localhost/api/cron/plateaus", { headers: { authorization: `Bearer ${"c".repeat(32)}` } }));
    expect(res.status).toBe(503);
  });
});
