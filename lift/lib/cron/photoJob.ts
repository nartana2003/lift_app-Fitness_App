/**
 * Server-only. GET /api/cron/photo-analysis, monthly on the 1st (vercel.json):
 * for every user with progress photos in the month that just ended, stores a
 * short analysis in `photo_analyses` (one row per user and month).
 *
 * - The first and last photo of the month are downloaded from the private
 *   `progress-photos` bucket (only paths inside the user's own folder) and go
 *   through the same validateInput as /api/ai/photo-analysis, which checks the
 *   bytes and strips metadata before anything reaches the model.
 * - The month's stats are computed here from set_facts, workouts,
 *   personal_records and body_weight measurements.
 * - With no key, no budget left, a failed call, an unusable answer or a photo
 *   the validator rejects, rulePhotoAnalysis() writes the row instead. Image
 *   data is never stored.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { runAi, type AiClient } from "../ai/client";
import {
  MAX_BODYWEIGHT,
  MAX_PR_COUNT,
  MIN_BODYWEIGHT,
  buildPrompt,
  encodeBase64,
  parseResponseText,
  rulePhotoAnalysis,
  sniffMediaType,
  validateInput,
  type MonthStats,
  type PhotoAnalysisInput,
  type PhotoAnalysisResult,
} from "../ai/photo-analysis";
import { MAX_DURATION_SEC, MAX_MUSCLE_SETS, MAX_SESSIONS, MAX_VOLUME } from "../ai/summary";
import type { MuscleGroup } from "../muscles";
import { PHOTO_BUCKET, remotePhotoFromRow, type RemotePhotoRow } from "../offline/remote";
import type { Unit } from "../units";
import { aiBudget, emptyResult, loadSetFacts, monthRange, previousMonth, MAX_USERS_PER_RUN, readAll, type CronJobResult, type SetFact } from "./job";

export type MonthPhoto = Pick<RemotePhotoRow, "id" | "taken_at" | "pose" | "storage_path">;

export type PhotoMonthUser = {
  userId: string;
  unit: Unit;
  /** The month's photos, oldest first. */
  photos: MonthPhoto[];
  stats: MonthStats;
};

export type PhotoAnalysisRow = {
  user_id: string;
  /** First day of the month, YYYY-MM-01. */
  month: string;
  photo_ids: string[];
  stats: MonthStats;
  ai_comment: string;
  focus: PhotoAnalysisResult["focus"];
  source: PhotoAnalysisResult["comment_source"];
};

export interface PhotoStore {
  /** Users with photos in `month` ("YYYY-MM") and no analysis row for it yet. */
  loadMonth(month: string): Promise<PhotoMonthUser[]>;
  /** Image bytes, or null when the object cannot be read. */
  download(path: string): Promise<Uint8Array | null>;
  saveAnalysis(row: PhotoAnalysisRow): Promise<void>;
}

const clampInt = (n: number, max: number) => Math.max(0, Math.min(max, Math.round(n)));
const bodyweight = (v: number | undefined) => (v !== undefined && v >= MIN_BODYWEIGHT && v <= MAX_BODYWEIGHT ? v : null);

/** Month stats in the shape (and inside the bounds) /api/ai/photo-analysis accepts. */
export function monthStats(
  facts: SetFact[],
  workouts: { started_at: string; duration_sec: number | null }[],
  prCount: number,
  weights: { date: string; value: number }[],
): MonthStats {
  let volume = 0;
  const sets: Partial<Record<MuscleGroup, number>> = {};
  for (const f of facts) {
    if (f.is_warmup) continue;
    volume += Math.max(0, f.reps) * Math.max(0, f.weight);
    for (const m of f.muscle_groups) sets[m] = (sets[m] ?? 0) + 1;
  }
  const sets_by_muscle: Partial<Record<MuscleGroup, number>> = {};
  for (const [m, n] of Object.entries(sets) as [MuscleGroup, number][]) sets_by_muscle[m] = clampInt(n, MAX_MUSCLE_SETS);
  const w = [...weights].sort((a, b) => a.date.localeCompare(b.date));
  return {
    sessions: clampInt(workouts.length, MAX_SESSIONS),
    duration_sec: clampInt(workouts.reduce((s, x) => s + (x.duration_sec ?? 0), 0), MAX_DURATION_SEC),
    volume: Math.min(MAX_VOLUME, Math.round(volume)),
    sets_by_muscle,
    pr_count: clampInt(prCount, MAX_PR_COUNT),
    bodyweight_start: bodyweight(w[0]?.value),
    bodyweight_end: bodyweight(w[w.length - 1]?.value),
  };
}

/** First and last photo of the month (one when there is only one). */
export const pickPhotos = (photos: MonthPhoto[]) => (photos.length > 1 ? [photos[0], photos[photos.length - 1]] : photos.slice(0, 1));

/** Input for the rule-based answer when the images cannot be used: dates and poses only, no image data. */
function metadataInput(month: string, u: PhotoMonthUser, picked: MonthPhoto[]): PhotoAnalysisInput {
  return {
    month,
    unit: u.unit,
    photos: picked.map((p) => ({ taken_on: p.taken_at.slice(0, 10), pose: p.pose, media_type: "image/jpeg", data: "", width: 0, height: 0 })),
    stats: u.stats,
  };
}

async function analyse(month: string, u: PhotoMonthUser, store: PhotoStore, takeAi: () => AiClient | null): Promise<PhotoAnalysisResult> {
  const picked = pickPhotos(u.photos);
  const photos: Record<string, unknown>[] = [];
  for (const p of picked) {
    const bytes = await store.download(p.storage_path);
    const media_type = bytes && sniffMediaType(bytes);
    if (!bytes || !media_type) return rulePhotoAnalysis(metadataInput(month, u, picked));
    photos.push({ taken_on: p.taken_at.slice(0, 10), pose: p.pose, media_type, data: encodeBase64(bytes) });
  }
  const checked = validateInput({ month, unit: u.unit, photos, stats: u.stats });
  if (!checked.ok) return rulePhotoAnalysis(metadataInput(month, u, picked));
  // Only users whose images reach the model use up the budget.
  const ai = takeAi();
  if (!ai) return rulePhotoAnalysis(checked.input);
  const res = await runAi(ai, buildPrompt(checked.input));
  return (res.ok && parseResponseText(res.text, checked.input)) || rulePhotoAnalysis(checked.input);
}

export async function runPhotoJob(store: PhotoStore, ai: AiClient | null, now: Date = new Date()): Promise<CronJobResult & { month: string }> {
  const month = previousMonth(now);
  const out = { ...emptyResult(), month };
  const budget = aiBudget(ai);
  const users = (await store.loadMonth(month)).slice(0, MAX_USERS_PER_RUN);
  out.users = users.length;
  for (const u of users) {
    if (!u.photos.length) {
      out.skipped++;
      continue;
    }
    try {
      const result = await analyse(month, u, store, budget.take);
      if (result.comment_source === "ai") out.ai++;
      else out.rule++;
      await store.saveAnalysis({
        user_id: u.userId,
        month: `${month}-01`,
        photo_ids: pickPhotos(u.photos).map((p) => p.id),
        stats: u.stats,
        ai_comment: result.comment.join("\n"),
        focus: result.focus,
        source: result.comment_source,
      });
      out.saved++;
    } catch {
      out.failed++;
    }
  }
  return out;
}

const str = (v: unknown) => (typeof v === "string" ? v : null);

/** PhotoStore backed by the service-role Supabase client (bypasses RLS; server only). */
export function supabasePhotoStore(admin: SupabaseClient): PhotoStore {
  return {
    async loadMonth(month) {
      const { start, end } = monthRange(month);
      const range = <T extends { gte(c: string, v: string): T; lt(c: string, v: string): T }>(q: T, col: string) =>
        q.gte(col, start.toISOString()).lt(col, end.toISOString());

      const photoRows = await readAll(() => range(admin.from("progress_photos").select("id, user_id, taken_at, pose, storage_path"), "taken_at").order("taken_at").order("id"));
      const photosOf = new Map<string, MonthPhoto[]>();
      for (const r of photoRows) {
        const uid = str(r.user_id);
        const p = uid && remotePhotoFromRow(uid, r);
        if (uid && p) photosOf.set(uid, [...(photosOf.get(uid) ?? []), p]);
      }
      const done = await readAll(() => admin.from("photo_analyses").select("id, user_id").eq("month", `${month}-01`).order("id"));
      for (const d of done) if (typeof d.user_id === "string") photosOf.delete(d.user_id);
      const ids = [...photosOf.keys()];
      if (!ids.length) return [];

      const facts = await loadSetFacts(admin, start, end, ids);
      const workouts = await readAll(() => range(admin.from("workouts").select("id, user_id, started_at, duration_sec").in("user_id", ids), "started_at").order("id"));
      const prs = await readAll(() => range(admin.from("personal_records").select("id, user_id").in("user_id", ids), "achieved_at").order("id"));
      const weights = await readAll(() =>
        admin
          .from("measurements")
          .select("id, user_id, date, value")
          .in("user_id", ids)
          .eq("type", "body_weight")
          .gte("date", start.toISOString().slice(0, 10))
          .lt("date", end.toISOString().slice(0, 10))
          .order("id"),
      );
      const profiles = await readAll(() => admin.from("profiles").select("id, unit_pref").in("id", ids).order("id"));

      return ids.map((userId) => {
        const own = <T extends Record<string, unknown>>(rows: T[]) => rows.filter((r) => r.user_id === userId);
        const unit = profiles.find((p) => p.id === userId)?.unit_pref === "lb" ? "lb" : "kg";
        return {
          userId,
          unit,
          photos: photosOf.get(userId)!,
          stats: monthStats(
            facts.filter((f) => f.user_id === userId),
            own(workouts).map((w) => ({ started_at: String(w.started_at), duration_sec: typeof w.duration_sec === "number" ? w.duration_sec : null })),
            own(prs).length,
            own(weights)
              .map((m) => ({ date: String(m.date), value: Number(m.value) }))
              .filter((m) => Number.isFinite(m.value)),
          ),
        };
      });
    },
    async download(path) {
      const { data, error } = await admin.storage.from(PHOTO_BUCKET).download(path);
      if (error || !data) return null;
      return new Uint8Array(await data.arrayBuffer());
    },
    async saveAnalysis(row) {
      const { error } = await admin.from("photo_analyses").insert(row);
      if (error) throw new Error("insert failed");
    },
  };
}
