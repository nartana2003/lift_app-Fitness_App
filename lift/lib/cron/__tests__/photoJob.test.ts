import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiClient, AiMessage, AiParams } from "../../ai/client";
import type { MonthStats } from "../../ai/photo-analysis";
import type { SetFact } from "../job";
import { monthStats, pickPhotos, runPhotoJob, supabasePhotoStore, type MonthPhoto, type PhotoAnalysisRow, type PhotoMonthUser, type PhotoStore } from "../photoJob";
import { GET } from "../../../app/api/cron/photo-analysis/route";
import { fakeAdmin } from "./fakeAdmin";

// Mocked store, admin client and AI client only.

// --- a minimal JPEG with an EXIF secret (same layout as the photo-analysis tests) ---
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const seg = (marker: number, payload: number[]) => [0xff, marker, ...u16(payload.length + 2), ...payload];
const SECRET = "GPS-SECRET-51.5N";
const JPEG = Uint8Array.from([
  0xff, 0xd8,
  ...seg(0xe0, [...ascii("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0]),
  ...seg(0xe1, [...ascii("Exif\0\0"), ...ascii(SECRET)]),
  ...seg(0xdb, [0, ...new Array(64).fill(1)]),
  ...seg(0xc0, [8, ...u16(800), ...u16(640), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
  ...seg(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]),
  0x12, 0x34, 0xff, 0xd9,
]);

const NOW = new Date("2026-11-01T06:00:00Z");
const STATS: MonthStats = { sessions: 12, duration_sec: 36_000, volume: 50_000, sets_by_muscle: { Chest: 40, Back: 30 }, pr_count: 3, bodyweight_start: 80, bodyweight_end: 79 };
const photo = (id: string, day: string): MonthPhoto => ({ id, taken_at: `2026-10-${day}T08:00:00.000Z`, pose: "front", storage_path: `u1/${id}.jpg` });
const user = (o: Partial<PhotoMonthUser> = {}): PhotoMonthUser => ({ userId: "u1", unit: "kg", photos: [photo("a", "02"), photo("b", "15"), photo("c", "29")], stats: STATS, ...o });

function memStore(users: PhotoMonthUser[], files: Record<string, Uint8Array | null> = { "u1/a.jpg": JPEG, "u1/c.jpg": JPEG }) {
  const saved: PhotoAnalysisRow[] = [];
  const downloads: string[] = [];
  const store: PhotoStore = {
    loadMonth: async () => users,
    download: async (p) => (downloads.push(p), files[p] ?? null),
    saveAnalysis: async (r) => void saved.push(r),
  };
  return { store, saved, downloads };
}

const msg = (text: string) =>
  ({ id: "m", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text, citations: null }], stop_reason: "end_turn", stop_details: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }) as unknown as AiMessage;
function fakeAi(text: string) {
  const calls: AiParams[] = [];
  const client: AiClient = { createMessage: async (p) => (calls.push(p), msg(text)) };
  return { client, calls };
}
const AI = JSON.stringify({ comment: ["Twelve sessions and steady chest work."], focus: [{ muscle: "Back", text: "Keep back sets near chest sets." }] });

describe("runPhotoJob", () => {
  it("analyses the month before the run with rules when there is no AI client", async () => {
    const { store, saved, downloads } = memStore([user()]);
    const out = await runPhotoJob(store, null, NOW);
    expect(out).toEqual({ month: "2026-10", users: 1, saved: 1, ai: 0, rule: 1, skipped: 0, failed: 0 });
    expect(downloads).toEqual(["u1/a.jpg", "u1/c.jpg"]);
    expect(saved[0]).toMatchObject({ user_id: "u1", month: "2026-10-01", photo_ids: ["a", "c"], stats: STATS, source: "rule" });
    expect(saved[0].ai_comment).toContain("October 2026: 12 sessions");
    expect(saved[0].ai_comment).toContain("27 days apart");
  });

  it("sends the cleaned images to the model and stores its comment, never image data", async () => {
    const { client, calls } = fakeAi(AI);
    const { store, saved } = memStore([user()]);
    expect((await runPhotoJob(store, client, NOW)).ai).toBe(1);
    expect(calls).toHaveLength(1);
    const sent = JSON.stringify(calls[0]);
    expect(sent).toContain('"type":"image"');
    expect(Buffer.from(sent).includes(Buffer.from(SECRET))).toBe(false);
    expect(sent).not.toContain(Buffer.from(SECRET).toString("base64").slice(0, 12));
    expect(saved[0]).toMatchObject({ source: "ai", ai_comment: "Twelve sessions and steady chest work." });
    expect(saved[0].focus[0]).toMatchObject({ muscle: "Back", source: "ai" });
    expect(JSON.stringify(saved)).not.toContain("/9j/");
  });

  it("falls back to rules on malformed output, a missing image or a non-image file, without spending budget on bad images", async () => {
    const bad = fakeAi("{");
    const r1 = memStore([user()]);
    await runPhotoJob(r1.store, bad.client, NOW);
    expect(r1.saved[0].source).toBe("rule");

    const { client, calls } = fakeAi(AI);
    const r2 = memStore([user(), user({ userId: "u2", photos: [{ ...photo("x", "05"), storage_path: "u2/x.jpg" }] })], { "u1/a.jpg": null, "u2/x.jpg": Uint8Array.from(ascii("GIF89a not a jpeg at all, just text bytes")) });
    const out = await runPhotoJob(r2.store, client, NOW);
    expect(out).toMatchObject({ saved: 2, rule: 2, ai: 0 });
    expect(calls).toHaveLength(0);
    expect(r2.saved[1].ai_comment).toContain("Add a second photo");
  });

  it("skips users without photos and counts a failed save", async () => {
    let n = 0;
    const store: PhotoStore = {
      loadMonth: async () => [user({ photos: [] }), user(), user({ userId: "u2" })],
      download: async () => JPEG,
      saveAnalysis: async () => {
        if (n++ === 0) throw new Error("db");
      },
    };
    expect(await runPhotoJob(store, null, NOW)).toMatchObject({ users: 3, skipped: 1, failed: 1, saved: 1 });
  });
});

describe("monthStats", () => {
  const f = (o: Partial<SetFact>): SetFact => ({ user_id: "u1", workout_id: "w1", started_at: "2026-10-01T10:00:00.000Z", exercise_id: "bench", reps: 10, weight: 50, is_warmup: false, muscle_groups: ["Chest", "Triceps"], ...o });

  it("sums working volume and sets per muscle, first and last bodyweight", () => {
    const s = monthStats([f({}), f({ is_warmup: true }), f({ muscle_groups: ["Chest"] })], [{ started_at: "x", duration_sec: 3600 }, { started_at: "y", duration_sec: null }], 2, [
      { date: "2026-10-20", value: 79.5 },
      { date: "2026-10-02", value: 81 },
    ]);
    expect(s).toEqual({ sessions: 2, duration_sec: 3600, volume: 1000, sets_by_muscle: { Chest: 2, Triceps: 1 }, pr_count: 2, bodyweight_start: 81, bodyweight_end: 79.5 });
  });

  it("clamps to the photo-analysis bounds and drops impossible bodyweights", () => {
    const s = monthStats([], Array.from({ length: 90 }, () => ({ started_at: "x", duration_sec: 99_999_999 })), 500, [{ date: "2026-10-01", value: 5 }]);
    expect(s).toMatchObject({ sessions: 62, duration_sec: 31 * 86_400, pr_count: 100, bodyweight_start: null, bodyweight_end: null });
  });
});

describe("pickPhotos", () => {
  it("takes the first and last photo, or the only one", () => {
    expect(pickPhotos([photo("a", "01"), photo("b", "02"), photo("c", "03")]).map((p) => p.id)).toEqual(["a", "c"]);
    expect(pickPhotos([photo("a", "01")]).map((p) => p.id)).toEqual(["a"]);
    expect(pickPhotos([])).toEqual([]);
  });
});

describe("supabasePhotoStore", () => {
  it("loads last month's photos (own folder only), skips analysed users, builds stats and inserts", async () => {
    const at = (d: string) => `2026-10-${d}T10:00:00.000Z`;
    const { admin, inserted } = fakeAdmin(
      {
        progress_photos: [
          { id: "a", user_id: "u1", taken_at: at("03"), pose: "front", storage_path: "u1/a.jpg" },
          { id: "evil", user_id: "u1", taken_at: at("04"), pose: "front", storage_path: "u2/b.jpg" },
          { id: "c", user_id: "u1", taken_at: at("28"), pose: "side", storage_path: "u1/c.jpg" },
          { id: "z", user_id: "u1", taken_at: "2026-11-01T10:00:00.000Z", pose: "front", storage_path: "u1/z.jpg" },
          { id: "d", user_id: "u3", taken_at: at("10"), pose: "front", storage_path: "u3/d.jpg" },
        ],
        photo_analyses: [{ id: "pa", user_id: "u3", month: "2026-10-01" }],
        set_facts: [{ set_id: "s1", user_id: "u1", workout_id: "w1", started_at: at("05"), exercise_id: "bench", reps: 10, weight: 60, is_warmup: false, muscle_groups: ["Chest"] }],
        workouts: [{ id: "w1", user_id: "u1", started_at: at("05"), duration_sec: 3000 }],
        personal_records: [{ id: "pr", user_id: "u1", achieved_at: at("05") }],
        measurements: [{ id: "m1", user_id: "u1", type: "body_weight", date: "2026-10-06", value: 80 }],
        profiles: [{ id: "u1", unit_pref: "lb" }],
      },
      { "u1/a.jpg": JPEG, "u1/c.jpg": JPEG },
    );
    const store = supabasePhotoStore(admin);
    const users = await store.loadMonth("2026-10");
    expect(users).toEqual([
      {
        userId: "u1",
        unit: "lb",
        photos: [expect.objectContaining({ id: "a" }), expect.objectContaining({ id: "c" })],
        stats: { sessions: 1, duration_sec: 3000, volume: 600, sets_by_muscle: { Chest: 1 }, pr_count: 1, bodyweight_start: 80, bodyweight_end: 80 },
      },
    ]);
    expect(await store.download("u1/a.jpg")).toEqual(JPEG);
    expect(await store.download("u1/missing.jpg")).toBeNull();

    await runPhotoJob(store, null, NOW);
    expect(inserted.photo_analyses).toEqual([expect.objectContaining({ user_id: "u1", month: "2026-10-01", photo_ids: ["a", "c"], source: "rule" })]);
  });
});

describe("GET /api/cron/photo-analysis", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("answers 401 without the secret and 503 without the service-role key", async () => {
    vi.stubEnv("CRON_SECRET", "c".repeat(32));
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect((await GET(new Request("http://localhost/api/cron/photo-analysis"))).status).toBe(401);
    const res = await GET(new Request("http://localhost/api/cron/photo-analysis", { headers: { authorization: `Bearer ${"c".repeat(32)}` } }));
    expect(res.status).toBe(503);
  });
});
