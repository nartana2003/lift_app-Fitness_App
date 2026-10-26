import { describe, expect, it } from "vitest";
import { authCallbackUrl, loginPathFor, MAX_NEXT_LENGTH, safeNext } from "../authRedirect";
import { handleAuthCallback } from "../authCallback";
import { isCronAuthorized, isCronPath } from "../cronAuth";
import { isAllowedPushEndpoint, toPushSub, vapidConfiguredFrom, adminConfiguredFrom } from "../push/endpoint";
import { createRateLimiter } from "../ai/guard";
import { handlePushSubscription, MAX_SUBSCRIBE_BYTES, parseSubscribeBody, type SubscribeDeps } from "../push/subscribe";
import { handleReminderCron, runReminderJob, MAX_SENDS_PER_RUN, type ReminderStore, type ReminderTarget } from "../push/reminderJob";
import type { PushSender } from "../push/send";
import { dedupePlannedDays, plannedDayFromRemote, toRemoteRow, isOwnPhotoPath, remotePhotoFromRow, measurementFromRemote, customExerciseFromRemote, routineFromRemote } from "../offline/remote";

// ---------- safeNext ----------
describe("safeNext hostile input", () => {
  const bad = [
    "//evil.com", "/\\evil.com", "\\\\evil.com", "\\/evil.com", "/\\/evil.com", "javascript:alert(1)", "https://evil.com", "http://evil.com/", "data:text/html,x", "evil.com", "", " /x", "/ x", "/\tx", "/\n/evil.com", "/\r\n/evil.com",
    "/\u0000", "/\u007f", "/\u0085", "/.//evil.com", "/a/..//evil.com", "/./\\evil.com",
    "/login", "/login/", "/login?next=/x", "/login#x", "/login/../login", "/x/../login", "/a/%2e%2e/login", "/login/anything",
    "/" + "a".repeat(MAX_NEXT_LENGTH), "?x=1", "#x", "./x",
  ];
  for (const raw of bad) {
    it(`rejects ${JSON.stringify(raw.slice(0, 40))}`, () => {
      expect(safeNext(raw, "/home")).toBe("/home");
    });
  }
  it("rejects non-strings", () => {
    for (const v of [null, undefined, 5, {}, [], ["/x"]] as unknown[]) expect(safeNext(v as string, "/f")).toBe("/f");
  });
  it("encoded slashes stay literal and same-origin", () => {
    for (const raw of ["/%2F/evil.com", "/%2fevil.com", "/%5Cevil.com", "/%09/evil.com", "/%0d%0a/evil.com"]) {
      const out = safeNext(raw);
      expect(out.startsWith("/")).toBe(true);
      expect(out.startsWith("//")).toBe(false);
      expect(new URL(out, "https://app.test").origin).toBe("https://app.test");
    }
  });
  it("keeps good paths, query and hash; unicode is percent-encoded", () => {
    expect(safeNext("/save?url=https%3A%2F%2Fa.com%2Fx&y=1#h")).toBe("/save?url=https%3A%2F%2Fa.com%2Fx&y=1#h");
    expect(safeNext("/é")).toBe("/%C3%A9");
    expect(safeNext("/" + "a".repeat(MAX_NEXT_LENGTH - 1))).toHaveLength(MAX_NEXT_LENGTH);
    expect(safeNext("/loginx")).toBe("/loginx");
  });
  it("is idempotent and never leaves the origin (seeded fuzz)", () => {
    let s = 12345;
    const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const alphabet = ["/", "\\", ".", "%2f", "%5c", "a", "?", "#", "@", ":", "\t", "‮", "é", "login", "//", "..", " "];
    for (let i = 0; i < 3000; i++) {
      let raw = "";
      const n = 1 + Math.floor(rnd() * 8);
      for (let j = 0; j < n; j++) raw += alphabet[Math.floor(rnd() * alphabet.length)];
      const out = safeNext(raw);
      expect(new URL(out, "https://app.test").origin, raw).toBe("https://app.test");
      expect(out.startsWith("//"), raw).toBe(false);
      expect(safeNext(out), raw).toBe(out);
    }
  });
  it("authCallbackUrl and loginPathFor never carry unsafe next", () => {
    expect(authCallbackUrl("https://a.test", "//evil.com")).toBe("https://a.test/auth/callback");
    expect(authCallbackUrl("https://a.test", "/save?u=1")).toBe("https://a.test/auth/callback?next=%2Fsave%3Fu%3D1");
    expect(loginPathFor("/login")).toBe("/login");
    expect(loginPathFor("//evil.com", "")).toBe("/login");
    expect(loginPathFor("/save", "?url=a&b=c")).toBe("/login?next=%2Fsave%3Furl%3Da%26b%3Dc");
  });
});

// ---------- auth callback ----------
describe("handleAuthCallback", () => {
  const ok = async () => null;
  const run = (qs: string, ex: (c: string) => Promise<string | null> = ok, base = "https://lift.test") =>
    handleAuthCallback(new Request(`${base}/auth/callback${qs}`), ex);
  it("redirects to own origin even with hostile next", async () => {
    for (const next of ["//evil.com", "https://evil.com", "/\\evil.com", "javascript:1"]) {
      const res = await run(`?code=c&next=${encodeURIComponent(next)}`);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("https://lift.test/");
    }
  });
  it("origin / redirect_to query params cannot change the origin", async () => {
    const res = await run(`?code=c&next=${encodeURIComponent("/x")}&origin=https://evil.com&redirect_to=https://evil.com`);
    expect(res.headers.get("location")).toBe("https://lift.test/x");
  });
  it("keeps port and path", async () => {
    const res = await run("?code=c&next=%2Fsave%3Fu%3D1", ok, "http://localhost:3123");
    expect(res.headers.get("location")).toBe("http://localhost:3123/save?u=1");
  });
  it("missing, huge or failing code goes to /login with error=link, next kept only if safe", async () => {
    const calls: string[] = [];
    const ex = async (c: string) => (calls.push(c), "bad");
    for (const qs of ["", "?code=", `?code=${"a".repeat(513)}`, "?code=c", "?code=c&next=%2Fsave"]) {
      const res = await run(qs, ex);
      const loc = new URL(res.headers.get("location")!);
      expect(loc.origin).toBe("https://lift.test");
      expect(loc.pathname).toBe("/login");
      expect(loc.searchParams.get("error")).toBe("link");
    }
    expect(calls).toEqual(["c", "c"]);
    const withNext = await run("?code=c&next=%2Fsave", ex);
    expect(new URL(withNext.headers.get("location")!).searchParams.get("next")).toBe("/save");
    const evil = await run("?code=c&next=%2F%2Fevil.com", ex);
    expect(new URL(evil.headers.get("location")!).searchParams.get("next")).toBeNull();
  });
  it("exchange throwing is a login redirect, not a 500", async () => {
    const res = await run("?code=c", async () => {
      throw new Error("boom");
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/login");
  });
  it("next=/login does not loop", async () => {
    const res = await run("?code=c&next=%2Flogin");
    expect(res.headers.get("location")).toBe("https://lift.test/");
  });
});

// ---------- cron auth ----------
describe("cron auth", () => {
  it("rejects missing, empty, wrong, case and whitespace variants", () => {
    const s = "s3cret";
    expect(isCronAuthorized(`Bearer ${s}`, s)).toBe(true);
    for (const h of [null, undefined, "", s, `bearer ${s}`, `Bearer ${s} `, ` Bearer ${s}`, `Bearer ${s}x`, `Bearer ${s.slice(0, -1)}`, `Basic ${s}`, "Bearer ", "Bearer"]) {
      expect(isCronAuthorized(h as string, s), String(h)).toBe(false);
    }
  });
  it("no secret configured fails closed, even for matching junk", () => {
    for (const secret of [undefined, ""]) {
      expect(isCronAuthorized("Bearer ", secret)).toBe(false);
      expect(isCronAuthorized("Bearer undefined", secret)).toBe(false);
      expect(isCronAuthorized(null, secret)).toBe(false);
    }
  });
  it("unicode and long headers do not throw", () => {
    expect(isCronAuthorized("Bearer " + "é".repeat(100000), "x")).toBe(false);
    expect(isCronAuthorized("Bearer é", "é")).toBe(true);
  });
  it("isCronPath only matches the prefix segment", () => {
    expect(isCronPath("/api/cron")).toBe(true);
    expect(isCronPath("/api/cron/reminders")).toBe(true);
    for (const p of ["/api/cronjob", "/api/crons", "/api/Cron/x", "/x/api/cron"]) expect(isCronPath(p), p).toBe(false);
  });
});

// ---------- push endpoint ----------
describe("isAllowedPushEndpoint (SSRF)", () => {
  const good = [
    "https://fcm.googleapis.com/fcm/send/abc", "https://android.googleapis.com/gcm/send/x", "https://updates.push.services.mozilla.com/wpush/v2/x",
    "https://web.push.apple.com/Q", "https://api.push.apple.com/3/device/x", "https://wns2-par02p.notify.windows.com/w/?token=x", "https://FCM.GOOGLEAPIS.COM/x",
    "https://fcm.googleapis.com:443/x",
  ];
  const bad = [
    "http://fcm.googleapis.com/x", "https://fcm.googleapis.com.evil.com/x", "https://evilfcm.googleapis.com/x", "https://x.fcm.googleapis.com/x",
    "https://evil.com/fcm.googleapis.com", "https://evil.com?fcm.googleapis.com", "https://evil.com#.push.apple.com", "https://fcm.googleapis.com@evil.com/x",
    "https://user@fcm.googleapis.com/x", "https://user:pw@fcm.googleapis.com/x", "https://fcm.googleapis.com:8443/x", "https://fcm.googleapis.com:80/x",
    "https://127.0.0.1/x", "https://[::1]/x", "https://10.0.0.1/x", "https://169.254.169.254/latest/meta-data", "https://localhost/x", "https://0x7f.1/x", "https://2130706433/x",
    "https://[::ffff:127.0.0.1]/x", "https://push.apple.com/x", "https://.push.apple.com/x", "https://notify.windows.com/x", "https://evilnotify.windows.com/x",
    "https://fcm.googleapis.com./x", "https://fcm.googIeapis.com/x", "https://evil.com\\@fcm.googleapis.com/x",
    "ftp://fcm.googleapis.com/x", "javascript:alert(1)", "//fcm.googleapis.com/x", "fcm.googleapis.com/x", "", " https://fcm.googleapis.com/x",
    "https://fcm.googleapis.com/" + "a".repeat(1100),
  ];
  for (const e of good) it(`allows ${e.slice(0, 60)}`, () => expect(isAllowedPushEndpoint(e)).toBe(true));
  for (const e of bad) it(`rejects ${e.slice(0, 60)}`, () => expect(isAllowedPushEndpoint(e)).toBe(false));
  it("rejects non-strings", () => {
    for (const v of [null, undefined, 1, {}, ["https://fcm.googleapis.com/x"], { toString: () => "https://fcm.googleapis.com/x" }]) expect(isAllowedPushEndpoint(v)).toBe(false);
  });
  it("toPushSub strips extra fields and rejects bad keys", () => {
    const keys = { p256dh: "B" + "A".repeat(86), auth: "a".repeat(22) };
    const out = toPushSub({ endpoint: "https://fcm.googleapis.com/x", keys: { ...keys }, isAdmin: true });
    expect(out).toEqual({ endpoint: "https://fcm.googleapis.com/x", keys });
    expect(toPushSub({ endpoint: "https://fcm.googleapis.com/x", keys: { ...keys, extra: "x" } })).toBeNull();
    expect(toPushSub({ endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: "<script>".padEnd(87, "A"), auth: keys.auth } })).toBeNull();
    expect(toPushSub({ endpoint: "https://fcm.googleapis.com/x", keys: [] })).toBeNull();
    expect(toPushSub([])).toBeNull();
  });
  it("config checks treat blanks and placeholders as missing", () => {
    expect(vapidConfiguredFrom({ NEXT_PUBLIC_VAPID_PUBLIC_KEY: " ", VAPID_PRIVATE_KEY: "a", VAPID_SUBJECT: "b" })).toBe(false);
    expect(adminConfiguredFrom({ NEXT_PUBLIC_SUPABASE_URL: "https://YOUR-PROJECT.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" })).toBe(false);
    expect(adminConfiguredFrom({ NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "  " })).toBe(false);
  });
});

// ---------- subscribe route ----------
const P256 = "B" + "A".repeat(86);
const AUTH = "a".repeat(22);
const EP = "https://fcm.googleapis.com/fcm/send/abc";
const GOOD = { endpoint: EP, expirationTime: null, keys: { p256dh: P256, auth: AUTH } };
const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "service",
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv", VAPID_SUBJECT: "mailto:a@b.c",
};
function setup(o: Partial<SubscribeDeps> = {}) {
  const log: string[] = [];
  const deps: SubscribeDeps = {
    env: ENV,
    resolveUser: async () => (log.push("resolve"), { id: "u1" }),
    store: () => ({ save: async (u, s) => void log.push(`save ${u} ${s.endpoint}`), remove: async (u, e) => void log.push(`remove ${u} ${e}`) }),
    limiter: createRateLimiter([{ windowMs: 60_000, max: 3 }]),
    ...o,
  };
  return { deps, log };
}
const post = (body: unknown, method = "POST", headers: Record<string, string> = {}) =>
  new Request("http://x/api/push/subscribe", { method, body: typeof body === "string" ? body : JSON.stringify(body), headers });

describe("subscribe route order and strictness", () => {
  it("503 comes before auth: resolver is never called without config", async () => {
    for (const drop of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]) {
      const { deps, log } = setup({ env: { ...ENV, [drop]: "" } });
      const res = await handlePushSubscription(post(GOOD), deps);
      expect(res.status, drop).toBe(503);
      expect(await res.json()).toEqual({ unavailable: true });
      expect(log).toEqual([]);
    }
  });
  it("401 before the body is read and before the limiter is consumed", async () => {
    const { deps, log } = setup({ resolveUser: async () => null });
    const req = post(GOOD);
    expect((await handlePushSubscription(req, deps)).status).toBe(401);
    expect(req.bodyUsed).toBe(false);
    expect(log).toEqual([]);
    for (const bad of [{ id: "" }, { id: "  " }, { id: 5 }] as never[]) {
      const r = await handlePushSubscription(post(GOOD), setup({ resolveUser: async () => bad }).deps);
      expect(r.status).toBe(401);
    }
    const thrower = await handlePushSubscription(
      post(GOOD),
      setup({
        resolveUser: async () => {
          throw new Error("x");
        },
      }).deps,
    );
    expect(thrower.status).toBe(401);
  });
  it("429 before body parse, with Retry-After; invalid requests also count; per user", async () => {
    const { deps, log } = setup();
    for (let i = 0; i < 3; i++) expect((await handlePushSubscription(post("not json"), deps)).status).toBe(400);
    const req = post(GOOD);
    const res = await handlePushSubscription(req, deps);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(req.bodyUsed).toBe(false);
    expect(log.some((l) => l.startsWith("save"))).toBe(false);
    const other = await handlePushSubscription(post(GOOD), { ...deps, resolveUser: async () => ({ id: "u2" }) });
    expect(other.status).toBe(200);
  });
  it("body cap: 413 on declared and on undeclared oversize, store never reached", async () => {
    const { deps, log } = setup();
    const big = JSON.stringify({ ...GOOD, pad: "x".repeat(MAX_SUBSCRIBE_BYTES) });
    expect((await handlePushSubscription(post(big, "POST", { "content-length": String(big.length) }), deps)).status).toBe(413);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 10; i++) c.enqueue(new TextEncoder().encode("x".repeat(1000)));
        c.close();
      },
    });
    const chunked = new Request("http://x/api/push/subscribe", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    expect((await handlePushSubscription(chunked, deps)).status).toBe(413);
    expect(log.filter((l) => l !== "resolve")).toEqual([]);
  });
  it("empty / array / null / scalar / unknown-key bodies are 400", async () => {
    const bodies: unknown[] = ["", "null", "[]", "5", '"s"', { ...GOOD, role: "admin" }, { ...GOOD, user_id: "u2" }, { ...GOOD, keys: { ...GOOD.keys, x: 1 } },
      { ...GOOD, expirationTime: "soon" }, { endpoint: EP }, { keys: GOOD.keys }, { ...GOOD, endpoint: "https://127.0.0.1/x" }];
    for (const b of bodies) {
      const { deps, log } = setup();
      const res = await handlePushSubscription(post(b as string), deps);
      expect(res.status, JSON.stringify(b)).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_request" });
      expect(log.filter((l) => l.startsWith("save"))).toEqual([]);
    }
  });
  it("saves under the signed-in user id", async () => {
    const { deps, log } = setup();
    expect((await handlePushSubscription(post(GOOD), deps)).status).toBe(200);
    expect(log).toContain(`save u1 ${EP}`);
  });
  it("DELETE accepts only { endpoint } and removes for this user", async () => {
    const { deps, log } = setup();
    expect((await handlePushSubscription(post({ endpoint: EP, keys: GOOD.keys }, "DELETE"), deps)).status).toBe(400);
    expect((await handlePushSubscription(post({ endpoint: "https://evil.com/x" }, "DELETE"), deps)).status).toBe(400);
    expect((await handlePushSubscription(post({ endpoint: EP }, "DELETE"), deps)).status).toBe(200);
    expect(log).toContain(`remove u1 ${EP}`);
  });
  it("store failure is a fixed 500 with no detail", async () => {
    const { deps } = setup({
      store: () => ({
        save: async () => {
          throw new Error("secret service key abc");
        },
        remove: async () => {},
      }),
    });
    const res = await handlePushSubscription(post(GOOD), deps);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('{"error":"failed"}');
  });
  it("parseSubscribeBody accepts expirationTime number or null only", () => {
    expect(parseSubscribeBody({ ...GOOD, expirationTime: 123 })).not.toBeNull();
    expect(parseSubscribeBody({ endpoint: GOOD.endpoint, keys: GOOD.keys })).not.toBeNull();
    expect(parseSubscribeBody({ ...GOOD, expirationTime: NaN })).toBeNull();
  });
});

// ---------- cron handler / job ----------
const target = (n: number, subs = 1): ReminderTarget => ({
  userId: `u${n}`, timezone: "UTC", reminders: { days: [0, 1, 2, 3, 4, 5, 6], time: "18:00" }, gymDates: [],
  subscriptions: Array.from({ length: subs }, (_, i) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${n}-${i}`, keys: GOOD.keys })),
});
const NOW = new Date("2026-10-26T18:10:00Z");
const CRON_ENV: Record<string, string | undefined> = { ...ENV, CRON_SECRET: "sec" };
const cronReq = (auth?: string) => new Request("http://x/api/cron/reminders", { method: "GET", headers: auth ? { authorization: auth } : {} });

describe("handleReminderCron", () => {
  const mk = (over: Partial<{ store: ReminderStore; env: Record<string, string | undefined> }> = {}) => {
    const loads: number[] = [];
    const store: ReminderStore = over.store ?? { loadTargets: async () => (loads.push(1), [target(1)]), removeSubscription: async () => {} };
    return { loads, deps: { env: over.env ?? CRON_ENV, store: () => store, send: (): PushSender => async () => ({ ok: true }), now: () => NOW } };
  };
  it("401 for missing/wrong secret, before the 503 check and before touching the store", async () => {
    const { deps, loads } = mk({ env: { ...CRON_ENV, VAPID_PRIVATE_KEY: "" } });
    for (const a of [undefined, "Bearer wrong", "sec", "bearer sec"]) expect((await handleReminderCron(cronReq(a), deps)).status).toBe(401);
    expect(loads).toEqual([]);
  });
  it("no CRON_SECRET configured: nothing authorised", async () => {
    const { deps } = mk({ env: { ...ENV } });
    expect((await handleReminderCron(cronReq("Bearer "), deps)).status).toBe(401);
    expect((await handleReminderCron(cronReq("Bearer undefined"), deps)).status).toBe(401);
  });
  it("503 without VAPID or admin key, store untouched", async () => {
    for (const drop of ["NEXT_PUBLIC_VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT", "SUPABASE_SERVICE_ROLE_KEY"]) {
      const { deps, loads } = mk({ env: { ...CRON_ENV, [drop]: undefined } });
      const res = await handleReminderCron(cronReq("Bearer sec"), deps);
      expect(res.status, drop).toBe(503);
      expect(loads).toEqual([]);
    }
  });
  it("200 with counts; store failure is fixed 500", async () => {
    const ok = await handleReminderCron(cronReq("Bearer sec"), mk().deps);
    expect(await ok.json()).toEqual({ users: 1, due: 1, sent: 1, failed: 0, removed: 0 });
    const bad = mk({
      store: {
        loadTargets: async () => {
          throw new Error("db password");
        },
        removeSubscription: async () => {},
      },
    });
    const res = await handleReminderCron(cronReq("Bearer sec"), bad.deps);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('{"error":"failed"}');
  });
  it("route file exports GET only", async () => {
    const mod = await import("../../app/api/cron/reminders/route");
    expect(Object.keys(mod).filter((k) => k !== "dynamic")).toEqual(["GET"]);
  });
});

describe("runReminderJob", () => {
  const store = (targets: ReminderTarget[], removed: string[] = [], failRemove = false): ReminderStore => ({
    loadTargets: async () => targets,
    removeSubscription: async (e) => {
      if (failRemove) throw new Error("x");
      removed.push(e);
    },
  });
  it("404/410 (gone) deletes only that subscription, others still get the push", async () => {
    const removed: string[] = [];
    const t = target(1, 3);
    const send: PushSender = async (s) => (s.endpoint.endsWith("-1") ? { ok: false, gone: true } : { ok: true });
    const r = await runReminderJob(store([t], removed), send, NOW);
    expect(r).toEqual({ users: 1, due: 1, sent: 2, failed: 1, removed: 1 });
    expect(removed).toEqual([t.subscriptions[1].endpoint]);
  });
  it("transient failure and thrown sender keep the subscription", async () => {
    const removed: string[] = [];
    let n = 0;
    const send: PushSender = async () => {
      if (n++ === 0) throw new Error("net");
      return { ok: false, gone: false };
    };
    const r = await runReminderJob(store([target(1, 2)], removed), send, NOW);
    expect(r).toMatchObject({ sent: 0, failed: 2, removed: 0 });
    expect(removed).toEqual([]);
  });
  it("a failing removal does not stop the run", async () => {
    const r = await runReminderJob(store([target(1, 2)], [], true), async () => ({ ok: false, gone: true }), NOW);
    expect(r).toMatchObject({ failed: 2, removed: 0 });
  });
  it("not due: no sends; payload is one JSON string", async () => {
    const payloads: string[] = [];
    const r = await runReminderJob(store([target(1)]), async (_s, p) => (payloads.push(p), { ok: true }), new Date("2026-10-26T12:00:00Z"));
    expect(r).toMatchObject({ due: 0, sent: 0 });
    await runReminderJob(store([target(1)]), async (_s, p) => (payloads.push(p), { ok: true }), NOW);
    expect(JSON.parse(payloads[0])).toMatchObject({ title: "Lift", kind: "reminder" });
  });
  it("caps pushes per run", async () => {
    const targets = Array.from({ length: 60 }, (_, i) => target(i, 100));
    let sent = 0;
    await runReminderJob(store(targets), async () => (sent++, { ok: true }), NOW);
    expect(sent).toBe(MAX_SENDS_PER_RUN);
  });
  it("a user with bad zone / junk reminders never throws", async () => {
    const t: ReminderTarget = { ...target(1), timezone: "Mars/Base", reminders: "junk" };
    await expect(runReminderJob(store([t, { ...t, reminders: null }, { ...t, reminders: { days: "x", time: 5 } }]), async () => ({ ok: true }), NOW)).resolves.toBeTruthy();
  });
});

// ---------- remote row mapping ----------
describe("remote row mapping", () => {
  const day = { id: "d1", date: "2026-10-26", routine_id: null, status: "moved" as const, workout_id: null, skip_reason: null, skip_note: null, moved_to: "2026-10-28", moved_from: null, created_at: "2026-10-20T00:00:00.000Z" };
  it("planned_days round trip keeps moved_to / moved_from and was_marked", () => {
    for (const marked of [true, false]) {
      const local = marked ? { ...day, was_marked: true } : day;
      const remote = toRemoteRow("planned_days", local, "u");
      expect(remote.was_marked).toBe(marked);
      expect(plannedDayFromRemote(remote)).toEqual(local);
    }
    const both = { ...day, moved_from: "2026-10-24", status: "planned" as const };
    expect(plannedDayFromRemote(toRemoteRow("planned_days", both, "u"))).toEqual(both);
  });
  it("toRemoteRow does not mutate input; exercises owner cannot be spoofed; custom flag dropped", () => {
    const row = { id: "custom-1", name: "X", custom: true, owner_id: "attacker" };
    const copy = JSON.stringify(row);
    const out = toRemoteRow("exercises", row, "me");
    expect(JSON.stringify(row)).toBe(copy);
    expect(out).toEqual({ id: "custom-1", name: "X", owner_id: "me" });
    expect(toRemoteRow("routines", { id: "r", name: "n", split_day_id: "" }, "u").split_day_id).toBeNull();
    expect(toRemoteRow("routines", { id: "r", name: "n", split_day_id: 5 }, "u").split_day_id).toBeNull();
    expect(toRemoteRow("routines", { id: "r", name: "n", split_day_id: "sd" }, "u").split_day_id).toBe("sd");
    expect(toRemoteRow("planned_days", { ...day, was_marked: "true" }, "u").was_marked).toBe(false);
    const w = { id: "w" };
    expect(toRemoteRow("workouts", w, "u")).toBe(w);
  });
  it("junk planned rows are null; partial rows get defaults", () => {
    for (const r of [{}, { id: "a" }, { date: "2026-10-26" }, { id: 5, date: "2026-10-26" }, { id: "a", date: "26-10-2026" }, { id: "a", date: null }, { id: "", date: "2026-10-26" }]) {
      expect(plannedDayFromRemote(r as never), JSON.stringify(r)).toBeNull();
    }
    const p = plannedDayFromRemote({ id: "a", date: "2026-10-26T00:00:00+00:00", status: "bogus", skip_reason: "alien", moved_to: "junk", moved_from: 5 })!;
    expect(p).toMatchObject({ date: "2026-10-26", status: "planned", skip_reason: null, moved_to: null, moved_from: null, routine_id: null });
    expect(p.created_at).toBe(new Date(0).toISOString());
    expect("was_marked" in p).toBe(false);
  });
  it("dedupePlannedDays: newest wins, tie by id, any input order (seeded)", () => {
    let s = 7;
    const rnd = () => (s = (s * 48271) % 2147483647) / 2147483647;
    const rows = Array.from({ length: 40 }, (_, i) => ({ ...day, id: `id${i}`, date: `2026-10-${10 + Math.floor(rnd() * 5)}`, created_at: `2026-10-0${1 + Math.floor(rnd() * 3)}T00:00:00Z` }));
    const expected = dedupePlannedDays(rows).map((r) => r.id).sort();
    for (let k = 0; k < 20; k++) {
      const shuffled = [...rows].sort(() => rnd() - 0.5);
      expect(dedupePlannedDays(shuffled).map((r) => r.id).sort()).toEqual(expected);
    }
    const dates = dedupePlannedDays(rows).map((r) => r.date);
    expect(new Set(dates).size).toBe(dates.length);
    expect(dedupePlannedDays([])).toEqual([]);
  });
  it("measurement / custom exercise / routine junk", () => {
    expect(measurementFromRemote({ id: "m", type: "weight", value: "81.5", date: "2026-10-20" })).toMatchObject({ value: 81.5 });
    for (const v of [null, "abc", Infinity, NaN, undefined, true]) expect(measurementFromRemote({ id: "m", type: "w", value: v, date: "2026-10-20" }), String(v)).toBeNull();
    expect(measurementFromRemote({ id: "m", type: "w", value: 0, date: "2026-10-20" })).not.toBeNull();
    expect(customExerciseFromRemote({ id: "bench", name: "x" })).toBeNull();
    expect(customExerciseFromRemote({ id: "custom-1", name: "x", muscle_groups: ["a", 5, null], instructions: "no" })).toMatchObject({ muscle_groups: ["a"], instructions: [], custom: true });
    expect(routineFromRemote({ id: "r", name: "n", source: "evil", kind: "x", platform: "myspace" })).toMatchObject({ source: "manual", kind: "routine", platform: null });
    expect(routineFromRemote({ id: "r" })).toBeNull();
  });
  it("photo paths: own folder only, no traversal, no nesting", () => {
    const u = "11111111-1111-4111-8111-111111111111";
    expect(isOwnPhotoPath(u, `${u}/p.jpg`)).toBe(true);
    for (const p of [`${u}/../x.jpg`, `${u}/a/b.jpg`, `${u}\\p.jpg`, `other/p.jpg`, `${u}x/p.jpg`, u, "", null, 5, `/${u}/p.jpg`, `${u}/` + "a".repeat(300)]) expect(isOwnPhotoPath(u, p), String(p)).toBe(false);
    expect(remotePhotoFromRow(u, { id: "p", taken_at: "garbage", storage_path: `${u}/p.jpg` })).toBeNull();
    expect(remotePhotoFromRow(u, { id: "p", taken_at: "2026-10-01T00:00:00Z", storage_path: `${u}/p.jpg`, pose: "diagonal" })?.pose).toBeNull();
  });
  it("photo path with an empty file name is rejected", () => {
    const u = "11111111-1111-4111-8111-111111111111";
    expect(isOwnPhotoPath(u, `${u}/`)).toBe(false);
  });
});
