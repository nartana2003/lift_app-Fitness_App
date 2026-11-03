/**
 * Server-only. Shared parts of the AI-backed cron jobs (CRON-01):
 * GET /api/cron/plateaus, /api/cron/photo-analysis, /api/cron/target-recheck.
 *
 * Order in every route: CRON_SECRET bearer check (401; middleware.ts checks it
 * too) -> service-role config check (503 unavailable) -> run -> JSON counts.
 * A missing ANTHROPIC_API_KEY is NOT an error here: the jobs run their
 * rule-based fallback for every user instead (the route passes a null client).
 * Data access sits behind a small store interface per job, so tests use
 * in-memory fakes, never Supabase.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAiClient, type AiClient } from "../ai/client";
import type { AiEnv } from "../ai/configured";
import { isCronAuthorized } from "../cronAuth";
import { adminConfiguredFrom } from "../push/endpoint";
import { isMuscle } from "../ai/validate";
import type { MuscleGroup } from "../muscles";

/** Model calls per run; every user past the budget gets the rule-based answer. */
export const MAX_AI_CALLS_PER_RUN = 25;
/** Users handled per run, so a bad row set cannot fan out without limit. */
export const MAX_USERS_PER_RUN = 500;
/** PostgREST returns at most 1000 rows per request by default, so reads are paged. */
export const PAGE_ROWS = 1000;
/** Rows read per query in total. */
export const MAX_ROWS = 20_000;

export type CronJobDeps<T> = {
  env: AiEnv;
  /** Runs the job; gets null when there is no AI key (rule-based only). */
  run: (ai: AiClient | null) => Promise<T>;
};

/** Full route handler; the route file only wires the real store. */
export async function handleCronJob<T>(req: Request, deps: CronJobDeps<T>): Promise<Response> {
  if (!isCronAuthorized(req.headers.get("authorization"), deps.env.CRON_SECRET)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!adminConfiguredFrom(deps.env)) return Response.json({ unavailable: true }, { status: 503 });
  try {
    return Response.json(await deps.run(getAiClient(deps.env)));
  } catch {
    return Response.json({ error: "failed" }, { status: 500 });
  }
}

/** Counts every job returns. */
export type CronJobResult = { users: number; saved: number; ai: number; rule: number; skipped: number; failed: number };

export const emptyResult = (): CronJobResult => ({ users: 0, saved: 0, ai: 0, rule: 0, skipped: 0, failed: 0 });

/** One call budget shared by a run. */
export function aiBudget(ai: AiClient | null, max = MAX_AI_CALLS_PER_RUN) {
  let left = ai ? max : 0;
  return {
    /** The client while calls are left (and counts one), else null. */
    take(): AiClient | null {
      if (!ai || left <= 0) return null;
      left--;
      return ai;
    },
  };
}

/** A query builder that can be paged (Supabase PostgREST builder). */
type Pageable = { range(from: number, to: number): PromiseLike<{ data: unknown; error: unknown }> };

/** Reads every page of a query (ordered by the caller), up to MAX_ROWS rows. */
export async function readAll(query: () => Pageable, max = MAX_ROWS): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let from = 0; from < max; from += PAGE_ROWS) {
    const { data, error } = await query().range(from, Math.min(from + PAGE_ROWS, max) - 1);
    if (error || !Array.isArray(data)) throw new Error("query failed");
    out.push(...(data as Record<string, unknown>[]));
    if (data.length < PAGE_ROWS) break;
  }
  return out;
}

/** One working or warm-up set with its workout and muscles (the set_facts view in 0001). */
export type SetFact = {
  user_id: string;
  workout_id: string;
  started_at: string;
  exercise_id: string;
  reps: number;
  weight: number;
  is_warmup: boolean;
  muscle_groups: MuscleGroup[];
};

/** A set_facts row checked field by field; null for anything malformed. */
export function toSetFact(r: Record<string, unknown>): SetFact | null {
  const { user_id, workout_id, started_at, exercise_id, reps, weight, is_warmup, muscle_groups } = r;
  if (typeof user_id !== "string" || typeof workout_id !== "string" || typeof exercise_id !== "string") return null;
  if (typeof started_at !== "string" || !Number.isFinite(Date.parse(started_at))) return null;
  const w = typeof weight === "string" ? Number(weight) : weight;
  if (typeof reps !== "number" || !Number.isFinite(reps) || typeof w !== "number" || !Number.isFinite(w)) return null;
  return {
    user_id,
    workout_id,
    started_at,
    exercise_id,
    reps,
    weight: w,
    is_warmup: is_warmup === true,
    muscle_groups: Array.isArray(muscle_groups) ? muscle_groups.filter(isMuscle) : [],
  };
}

/**
 * Sets logged in [since, until) from the set_facts view. The service-role
 * client bypasses RLS, so the view returns every user's rows; `userIds`
 * narrows it when given.
 */
export async function loadSetFacts(admin: SupabaseClient, since: Date, until: Date, userIds?: string[]): Promise<SetFact[]> {
  if (userIds && !userIds.length) return [];
  const rows = await readAll(() => {
    let q = admin
      .from("set_facts")
      .select("set_id, user_id, workout_id, started_at, exercise_id, reps, weight, is_warmup, muscle_groups")
      .gte("started_at", since.toISOString())
      .lt("started_at", until.toISOString());
    if (userIds) q = q.in("user_id", userIds);
    return q.order("started_at", { ascending: true }).order("set_id", { ascending: true });
  });
  return rows.map(toSetFact).filter((x): x is SetFact => x !== null);
}

/** "YYYY-MM" of the calendar month before `now` (UTC). */
export function previousMonth(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return d.toISOString().slice(0, 7);
}

/** [start, end) of a "YYYY-MM" month in UTC. */
export function monthRange(month: string): { start: Date; end: Date } {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1;
  return { start: new Date(Date.UTC(y, m, 1)), end: new Date(Date.UTC(y, m + 1, 1)) };
}
