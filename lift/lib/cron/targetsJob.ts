/**
 * Server-only. GET /api/cron/target-recheck, monthly on the 1st (vercel.json):
 * re-checks every user's weekly set targets (muscle_targets) against the last
 * 4 weeks of sets and stores suggested raises or cuts in target_suggestions
 * (status "open") for the user to approve. Targets themselves never change here.
 *
 * With a key (and budget left) the model words and picks the changes
 * (lib/ai/target-recheck.ts); with no key, a failed call or an unusable
 * answer, ruleRecheck() does. A user who already has suggestions for this
 * month, or who logged no sets in the 4 weeks, is skipped.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { runAi, type AiClient } from "../ai/client";
import { EXPERIENCES, GOAL_TYPES, MAX_WEEKS, MAX_WEEK_SETS, type WeekSets } from "../ai/goal-targets";
import { buildPrompt, parseResponseText, ruleRecheck, validateInput, type RecheckInput, type RecheckResult } from "../ai/target-recheck";
import { isMuscle } from "../ai/validate";
import type { MuscleGroup } from "../muscles";
import { aiBudget, emptyResult, loadSetFacts, MAX_USERS_PER_RUN, readAll, type CronJobResult, type SetFact } from "./job";

const DAY = 864e5;

export type TargetUser = { userId: string; input: unknown };

export type TargetSuggestionRow = {
  user_id: string;
  /** First day of the month the check ran in, YYYY-MM-01. */
  month: string;
  muscle_group: MuscleGroup;
  current_sets: number;
  suggested_sets: number;
  reason: string;
  source: RecheckResult["source"];
};

export interface TargetStore {
  /** Users with targets and no suggestions for `month` yet; input is checked by validateInput. */
  loadUsers(now: Date, month: string): Promise<TargetUser[]>;
  saveSuggestions(rows: TargetSuggestionRow[]): Promise<void>;
}

/** Start of the 4 full 7-day weeks before `now`'s UTC day, oldest first. */
export function weekStarts(now: Date): Date[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: MAX_WEEKS }, (_, i) => new Date(today - (MAX_WEEKS - i) * 7 * DAY));
}

/** Hard sets per muscle per week for one user (warm-ups not counted). */
export function weeklySets(facts: SetFact[], starts: Date[]): WeekSets[] {
  return starts.map((start) => {
    const end = start.getTime() + 7 * DAY;
    const sets: Partial<Record<MuscleGroup, number>> = {};
    for (const f of facts) {
      const t = Date.parse(f.started_at);
      if (f.is_warmup || t < start.getTime() || t >= end) continue;
      for (const m of f.muscle_groups) sets[m] = Math.min(MAX_WEEK_SETS, (sets[m] ?? 0) + 1);
    }
    return { week_start: start.toISOString().slice(0, 10), sets };
  });
}

async function recheck(input: RecheckInput, ai: AiClient | null): Promise<RecheckResult> {
  if (!ai) return ruleRecheck(input);
  const res = await runAi(ai, buildPrompt(input));
  return (res.ok && parseResponseText(res.text, input)) || ruleRecheck(input);
}

export async function runTargetsJob(store: TargetStore, ai: AiClient | null, now: Date = new Date()): Promise<CronJobResult & { month: string }> {
  const month = now.toISOString().slice(0, 7);
  const out = { ...emptyResult(), month };
  const budget = aiBudget(ai);
  const users = (await store.loadUsers(now, month)).slice(0, MAX_USERS_PER_RUN);
  out.users = users.length;
  for (const u of users) {
    const checked = validateInput(u.input);
    // No sets at all means no data (a break, or workouts not synced), not "missed every target".
    if (!checked.ok || checked.input.weeks.every((w) => Object.keys(w.sets).length === 0)) {
      out.skipped++;
      continue;
    }
    try {
      const result = await recheck(checked.input, budget.take());
      if (result.source === "ai") out.ai++;
      else out.rule++;
      if (!result.changes.length) continue;
      await store.saveSuggestions(
        result.changes.map((c) => ({
          user_id: u.userId,
          month: `${month}-01`,
          muscle_group: c.muscle,
          current_sets: c.current,
          suggested_sets: c.suggested,
          reason: c.reason,
          source: result.source,
        })),
      );
      out.saved += result.changes.length;
    } catch {
      out.failed++;
    }
  }
  return out;
}

/** TargetStore backed by the service-role Supabase client (bypasses RLS; server only). */
export function supabaseTargetStore(admin: SupabaseClient): TargetStore {
  return {
    async loadUsers(now, month) {
      const targets = await readAll(() => admin.from("muscle_targets").select("user_id, muscle_group, weekly_sets").order("user_id").order("muscle_group"));
      const targetsOf = new Map<string, Partial<Record<MuscleGroup, number>>>();
      for (const t of targets) {
        if (typeof t.user_id !== "string" || !isMuscle(t.muscle_group) || typeof t.weekly_sets !== "number" || t.weekly_sets <= 0) continue;
        targetsOf.set(t.user_id, { ...targetsOf.get(t.user_id), [t.muscle_group]: t.weekly_sets });
      }
      const done = await readAll(() => admin.from("target_suggestions").select("id, user_id").eq("month", `${month}-01`).order("id"));
      for (const d of done) if (typeof d.user_id === "string") targetsOf.delete(d.user_id);
      const ids = [...targetsOf.keys()];
      if (!ids.length) return [];

      const goals = await readAll(() => admin.from("goals").select("user_id, goal_type, experience_level, sessions_per_week, focus_muscles").in("user_id", ids).order("user_id"));
      const starts = weekStarts(now);
      const facts = await loadSetFacts(admin, starts[0], new Date(starts[starts.length - 1].getTime() + 7 * DAY), ids);
      return ids.map((userId) => {
        const g = goals.find((x) => x.user_id === userId);
        const usable = g && (GOAL_TYPES as readonly unknown[]).includes(g.goal_type) && (EXPERIENCES as readonly unknown[]).includes(g.experience_level);
        return {
          userId,
          input: {
            goals: usable
              ? {
                  goalType: g.goal_type,
                  experience: g.experience_level,
                  sessionsPerWeek: g.sessions_per_week,
                  focusMuscles: Array.isArray(g.focus_muscles) ? g.focus_muscles.filter(isMuscle) : [],
                }
              : null,
            targets: targetsOf.get(userId),
            weeks: weeklySets(
              facts.filter((f) => f.user_id === userId),
              starts,
            ),
          },
        };
      });
    },
    async saveSuggestions(rows) {
      const { error } = await admin.from("target_suggestions").upsert(rows, { onConflict: "user_id,month,muscle_group", ignoreDuplicates: true });
      if (error) throw new Error("insert failed");
    },
  };
}
