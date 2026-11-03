import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setAiClientFactory, type AiClient } from "../../ai/client";
import { isCronAuthorized, isCronPath } from "../../cronAuth";
import { aiBudget, handleCronJob, monthRange, PAGE_ROWS, previousMonth, readAll, toSetFact } from "../job";

// Mocked env and clients only: no Supabase project, no real key.

const SECRET = "s".repeat(32);
const ENV = {
  CRON_SECRET: SECRET,
  NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role",
  ANTHROPIC_API_KEY: "",
};
const req = (auth?: string) => new Request("http://localhost/api/cron/plateaus", { headers: auth ? { authorization: auth } : {} });
const fake: AiClient = { createMessage: async () => { throw new Error("not called"); } };

describe("handleCronJob", () => {
  afterEach(() => setAiClientFactory(null));

  it("answers 401 without the bearer secret and never runs the job", async () => {
    let ran = 0;
    const run = async () => ++ran;
    for (const auth of [undefined, "Bearer wrong", SECRET, `Bearer ${SECRET}x`, `Basic ${SECRET}`]) {
      const res = await handleCronJob(req(auth), { env: ENV, run });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    const noSecret = await handleCronJob(req(`Bearer ${SECRET}`), { env: { ...ENV, CRON_SECRET: "" }, run });
    expect(noSecret.status).toBe(401);
    expect(ran).toBe(0);
  });

  it("answers 503 unavailable when the service-role client is not configured", async () => {
    const res = await handleCronJob(req(`Bearer ${SECRET}`), { env: { ...ENV, SUPABASE_SERVICE_ROLE_KEY: "" }, run: async () => 1 });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ unavailable: true });
  });

  it("runs rule-based (null client) when there is no AI key", async () => {
    let got: AiClient | null | undefined;
    const res = await handleCronJob(req(`Bearer ${SECRET}`), { env: ENV, run: async (ai) => ((got = ai), { saved: 2 }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved: 2 });
    expect(got).toBeNull();
  });

  it("passes the AI client when a key is set", async () => {
    setAiClientFactory(() => fake);
    let got: AiClient | null = null;
    await handleCronJob(req(`Bearer ${SECRET}`), { env: { ...ENV, ANTHROPIC_API_KEY: "sk-test" }, run: async (ai) => ((got = ai), {}) });
    expect(got).toBe(fake);
  });

  it("answers 500 with a fixed body when the job throws", async () => {
    const res = await handleCronJob(req(`Bearer ${SECRET}`), { env: ENV, run: async () => { throw new Error("db password leaked"); } });
    expect(res.status).toBe(500);
    expect(await res.text()).toBe(JSON.stringify({ error: "failed" }));
  });
});

describe("aiBudget", () => {
  it("hands out the client a fixed number of times", () => {
    const b = aiBudget(fake, 2);
    expect([b.take(), b.take(), b.take()]).toEqual([fake, fake, null]);
    expect(aiBudget(null, 5).take()).toBeNull();
  });
});

describe("readAll", () => {
  const pager = (total: number, calls: number[][] = []) => () => ({
    range: async (from: number, to: number) => {
      calls.push([from, to]);
      return { data: Array.from({ length: Math.max(0, Math.min(total, to + 1) - from) }, (_, i) => ({ n: from + i })), error: null };
    },
  });

  it("reads pages until a short one", async () => {
    const calls: number[][] = [];
    const rows = await readAll(pager(PAGE_ROWS + 5, calls));
    expect(rows).toHaveLength(PAGE_ROWS + 5);
    expect(calls).toEqual([[0, PAGE_ROWS - 1], [PAGE_ROWS, 2 * PAGE_ROWS - 1]]);
  });

  it("stops at the row cap", async () => {
    expect(await readAll(pager(10 * PAGE_ROWS), 2 * PAGE_ROWS)).toHaveLength(2 * PAGE_ROWS);
  });

  it("throws on a query error", async () => {
    await expect(readAll(() => ({ range: async () => ({ data: null, error: { message: "x" } }) }))).rejects.toThrow();
  });
});

describe("toSetFact", () => {
  const row = { user_id: "u", workout_id: "w", started_at: "2026-10-01T10:00:00.000Z", exercise_id: "bench", reps: 5, weight: "100", is_warmup: false, muscle_groups: ["Chest", "</user_data>"] };

  it("keeps known muscles and parses numeric strings", () => {
    expect(toSetFact(row)).toEqual({ ...row, weight: 100, muscle_groups: ["Chest"] });
  });

  it("rejects malformed rows", () => {
    expect(toSetFact({ ...row, user_id: 1 })).toBeNull();
    expect(toSetFact({ ...row, started_at: "nope" })).toBeNull();
    expect(toSetFact({ ...row, reps: Number.NaN })).toBeNull();
    expect(toSetFact({ ...row, weight: "abc" })).toBeNull();
  });
});

describe("months", () => {
  it("gives the previous month across a year boundary", () => {
    expect(previousMonth(new Date("2026-11-01T06:00:00Z"))).toBe("2026-10");
    expect(previousMonth(new Date("2027-01-01T00:00:00Z"))).toBe("2026-12");
  });

  it("gives a [start, end) UTC range", () => {
    const { start, end } = monthRange("2026-12");
    expect(start.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("vercel.json crons", () => {
  const root = path.resolve(__dirname, "../../..");
  const config = JSON.parse(readFileSync(path.join(root, "vercel.json"), "utf8")) as { framework: string; crons: { path: string; schedule: string }[] };

  it("keeps the framework key and lists the weekly and monthly jobs only", () => {
    expect(config.framework).toBe("nextjs");
    expect(config.crons).toEqual([
      { path: "/api/cron/plateaus", schedule: "0 5 * * 1" },
      { path: "/api/cron/photo-analysis", schedule: "0 6 1 * *" },
      { path: "/api/cron/target-recheck", schedule: "0 7 1 * *" },
    ]);
  });

  it("points every cron at an existing route under the CRON_SECRET guard", () => {
    for (const c of config.crons) {
      expect(isCronPath(c.path)).toBe(true);
      expect(existsSync(path.join(root, "app", ...c.path.slice(1).split("/"), "route.ts"))).toBe(true);
    }
    expect(isCronAuthorized(null, SECRET)).toBe(false);
  });

  // Vercel Hobby rejects the deployment if any cron runs more than once a day.
  // Hourly reminders need Pro or an external scheduler (lib/push/reminderJob.ts).
  it("runs no cron more than once per day (Hobby-safe)", () => {
    const single = /^\d{1,2}$/;
    for (const c of config.crons) {
      const fields = c.schedule.trim().split(/\s+/);
      expect(fields).toHaveLength(5);
      expect(fields[0]).toMatch(single);
      expect(fields[1]).toMatch(single);
    }
    expect(config.crons.some((c) => c.path === "/api/cron/reminders")).toBe(false);
  });
});
