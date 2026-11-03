/**
 * Server-only. GET /api/cron/plateaus, weekly (vercel.json): finds stalled
 * lifts for every user and stores one fix per lift in `plateaus`.
 *
 * - The stall is detectPlateau() from lib/plateau.ts (the Progress card rule),
 *   measured at the time of the run, so a lift the user stopped doing is not
 *   flagged.
 * - Each lift goes through the same validateInput / buildContext as
 *   /api/ai/plateau-fix. With a key (and budget left) the model picks the
 *   fix; with no key, a failed call or an unusable answer, ruleFix() does.
 * - A lift that already has an open plateau row is skipped, so a weekly run
 *   does not pile up duplicates.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { runAi, type AiClient } from "../ai/client";
import { MAX_SESSIONS, MAX_SETS_PER_SESSION, MAX_REPS, MAX_WEIGHT, buildContext, buildPrompt, parseResponseText, ruleFix, validateInput, type HistorySession, type PlateauFixResult } from "../ai/plateau-fix";
import { GOAL_TYPES } from "../ai/goal-targets";
import { equipmentList } from "../ai/validate";
import type { Exercise } from "../exercises";
import type { Equipment } from "../muscles";
import type { GoalType } from "../goals";
import { detectPlateau } from "../plateau";
import { aiBudget, emptyResult, loadSetFacts, MAX_USERS_PER_RUN, readAll, type CronJobResult, type SetFact } from "./job";

/** History read per run: long enough for a 6-week stall plus the sessions before it. */
export const PLATEAU_HISTORY_DAYS = 120;

export type PlateauUser = {
  userId: string;
  goalType: GoalType | null;
  /** Empty means "no restriction". */
  equipment: Equipment[];
  /** Sessions per exercise id, any order. */
  histories: Map<string, HistorySession[]>;
  /** Exercise ids with an open plateau row. */
  openIds: Set<string>;
};

export type PlateauRow = {
  user_id: string;
  exercise_id: string;
  weeks_stalled: number;
  suggestion: string;
  fix: PlateauFixResult["fix"];
  source: PlateauFixResult["source"];
};

export interface PlateauStore {
  loadUsers(now: Date): Promise<PlateauUser[]>;
  savePlateau(row: PlateauRow): Promise<void>;
}

/** Groups set facts into per-user, per-exercise sessions (one per workout), capped to what plateau-fix accepts. */
export function sessionsFromFacts(facts: SetFact[]): Map<string, Map<string, HistorySession[]>> {
  const byWorkout = new Map<string, { user: string; ex: string; date: string; sets: HistorySession["sets"] }>();
  for (const f of facts) {
    if (!Number.isInteger(f.reps) || f.reps < 0 || f.reps > MAX_REPS || f.weight < 0 || f.weight > MAX_WEIGHT) continue;
    const key = `${f.user_id}\u0000${f.workout_id}\u0000${f.exercise_id}`;
    const s = byWorkout.get(key) ?? { user: f.user_id, ex: f.exercise_id, date: f.started_at.slice(0, 10), sets: [] };
    if (s.sets.length < MAX_SETS_PER_SESSION) s.sets.push(f.is_warmup ? { reps: f.reps, weight: f.weight, is_warmup: true } : { reps: f.reps, weight: f.weight });
    byWorkout.set(key, s);
  }
  const out = new Map<string, Map<string, HistorySession[]>>();
  for (const s of byWorkout.values()) {
    const user = out.get(s.user) ?? new Map<string, HistorySession[]>();
    user.set(s.ex, [...(user.get(s.ex) ?? []), { date: s.date, sets: s.sets }]);
    out.set(s.user, user);
  }
  return out;
}

async function fixFor(ctx: ReturnType<typeof buildContext>, ai: AiClient | null): Promise<PlateauFixResult> {
  if (!ai) return ruleFix(ctx);
  const res = await runAi(ai, buildPrompt(ctx));
  return (res.ok && parseResponseText(res.text, ctx)) || ruleFix(ctx);
}

export async function runPlateauJob(store: PlateauStore, ai: AiClient | null, catalogue: Exercise[], now: Date = new Date()): Promise<CronJobResult> {
  const out = emptyResult();
  const byId = new Map(catalogue.map((e) => [e.id, e]));
  const budget = aiBudget(ai);
  const users = (await store.loadUsers(now)).slice(0, MAX_USERS_PER_RUN);
  out.users = users.length;
  for (const u of users) {
    for (const [exerciseId, all] of u.histories) {
      if (u.openIds.has(exerciseId)) {
        out.skipped++;
        continue;
      }
      const sessions = [...all].sort((a, b) => a.date.localeCompare(b.date)).slice(-MAX_SESSIONS);
      // Stalled as of today, not just as of the last session.
      if (!detectPlateau(exerciseId, sessions, { now })) continue;
      const checked = validateInput({ exercise_id: exerciseId, sessions, equipment: u.equipment, goal_type: u.goalType }, byId);
      if (!checked.ok) continue;
      const ctx = buildContext(checked.input, catalogue);
      try {
        const result = await fixFor(ctx, budget.take());
        if (result.source === "ai") out.ai++;
        else out.rule++;
        await store.savePlateau({
          user_id: u.userId,
          exercise_id: exerciseId,
          weeks_stalled: result.weeks,
          suggestion: result.fix.reason,
          fix: result.fix,
          source: result.source,
        });
        out.saved++;
      } catch {
        out.failed++;
      }
    }
  }
  return out;
}

/** PlateauStore backed by the service-role Supabase client (bypasses RLS; server only). */
export function supabasePlateauStore(admin: SupabaseClient): PlateauStore {
  return {
    async loadUsers(now) {
      const since = new Date(now.getTime() - PLATEAU_HISTORY_DAYS * 864e5);
      const histories = sessionsFromFacts(await loadSetFacts(admin, since, now));
      const ids = [...histories.keys()];
      if (!ids.length) return [];
      const goals = await readAll(() => admin.from("goals").select("user_id, goal_type").in("user_id", ids).order("user_id"));
      const equipment = await readAll(() => admin.from("user_equipment").select("user_id, equipment").in("user_id", ids).order("user_id"));
      const open = await readAll(() => admin.from("plateaus").select("id, user_id, exercise_id").in("user_id", ids).eq("status", "open").order("id"));
      const goalOf = new Map<string, GoalType>();
      for (const g of goals) {
        if (typeof g.user_id === "string" && (GOAL_TYPES as readonly unknown[]).includes(g.goal_type)) goalOf.set(g.user_id, g.goal_type as GoalType);
      }
      const equipOf = new Map<string, Equipment[]>();
      for (const e of equipment) {
        const list = equipmentList(e.equipment);
        if (typeof e.user_id === "string" && list) equipOf.set(e.user_id, list);
      }
      const openOf = new Map<string, Set<string>>();
      for (const p of open) {
        if (typeof p.user_id !== "string" || typeof p.exercise_id !== "string") continue;
        openOf.set(p.user_id, (openOf.get(p.user_id) ?? new Set()).add(p.exercise_id));
      }
      return ids.map((userId) => ({
        userId,
        goalType: goalOf.get(userId) ?? null,
        equipment: equipOf.get(userId) ?? [],
        histories: histories.get(userId)!,
        openIds: openOf.get(userId) ?? new Set(),
      }));
    },
    async savePlateau(row) {
      const { error } = await admin.from("plateaus").insert({ ...row, status: "open" });
      if (error) throw new Error("insert failed");
    },
  };
}
