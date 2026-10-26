import "fake-indexeddb/auto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Browser push flow with stubbed navigator / Notification / fetch and a fake
// Supabase client. No real push service, no real project.

const VAPID = "BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", VAPID);

const supa = vi.hoisted(() => {
  const state = { session: true, upserts: [] as Record<string, unknown>[], error: null as null | { message: string } };
  const client = {
    auth: { getSession: async () => ({ data: { session: state.session ? { user: { id: "u1" } } : null } }) },
    from: (t: string) => ({
      upsert: async (row: Record<string, unknown>) => {
        state.upserts.push({ table: t, ...row });
        return { error: state.error };
      },
    }),
  };
  return { state, client };
});
vi.mock("@/lib/supabase/configured", () => ({ supabaseConfigured: true }));
vi.mock("@/lib/supabase/client", () => ({ supabaseBrowser: () => supa.client }));

const subJson = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", expirationTime: null, keys: { p256dh: "p", auth: "a" } };
const pm = {
  current: null as null | { endpoint: string; toJSON: () => unknown; unsubscribe: () => Promise<boolean> },
  subscribeArgs: [] as unknown[],
  getSubscription: async () => pm.current,
  subscribe: async (opts: unknown) => {
    pm.subscribeArgs.push(opts);
    pm.current = { endpoint: subJson.endpoint, toJSON: () => subJson, unsubscribe: async () => ((pm.current = null), true) };
    return pm.current;
  },
};
const notification = { permission: "default" as NotificationPermission, answer: "granted" as NotificationPermission };
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

vi.stubGlobal("navigator", { onLine: true, serviceWorker: { ready: Promise.resolve({ pushManager: pm }) } });
vi.stubGlobal("window", { PushManager: function PushManager() {}, Notification: {} });
vi.stubGlobal("Notification", {
  get permission() {
    return notification.permission;
  },
  requestPermission: async () => (notification.permission = notification.answer),
});
vi.stubGlobal("fetch", fetchMock);

const { enablePush, disablePush, currentPushState, pushAvailable, syncReminderSettings, SUBSCRIBE_URL } = await import("../client");
const { DEFAULT_REMINDERS } = await import("../../reminders");

afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  pm.current = null;
  pm.subscribeArgs.length = 0;
  notification.permission = "default";
  notification.answer = "granted";
  supa.state.session = true;
  supa.state.upserts.length = 0;
  supa.state.error = null;
  fetchMock.mockClear();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
});

const R = { ...DEFAULT_REMINDERS, days: [1, 3], time: "07:00" };

describe("push client", () => {
  it("is available with the stubs", () => {
    expect(pushAvailable()).toBe(true);
  });

  it("enable: asks permission, subscribes with the VAPID key, posts the subscription, saves the schedule", async () => {
    expect(await enablePush(R)).toBe("on");
    expect(pm.subscribeArgs).toHaveLength(1);
    const opts = pm.subscribeArgs[0] as { userVisibleOnly: boolean; applicationServerKey: Uint8Array };
    expect(opts.userVisibleOnly).toBe(true);
    expect(opts.applicationServerKey).toHaveLength(65);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(SUBSCRIBE_URL);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(subJson);
    expect(supa.state.upserts[0]).toMatchObject({ table: "profiles", id: "u1", reminders: R, reminder_days: [1, 3], reminder_time: "07:00" });
    expect(typeof supa.state.upserts[0].timezone).toBe("string");
    expect(await currentPushState()).toBe("on");
  });

  it("reuses an existing subscription", async () => {
    await pm.subscribe({});
    pm.subscribeArgs.length = 0;
    expect(await enablePush(R)).toBe("on");
    expect(pm.subscribeArgs).toHaveLength(0);
  });

  it("denied permission stops before subscribing", async () => {
    notification.answer = "denied";
    expect(await enablePush(R)).toBe("denied");
    expect(pm.subscribeArgs).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await currentPushState()).toBe("denied");
  });

  it("maps 401 to signin, 503 to unavailable, other errors to error", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    expect(await enablePush(R)).toBe("signin");
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 503 }));
    expect(await enablePush(R)).toBe("unavailable");
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 500 }));
    expect(await enablePush(R)).toBe("error");
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    expect(await enablePush(R)).toBe("error");
  });

  it("disable unsubscribes and tells the server", async () => {
    await enablePush(R);
    fetchMock.mockClear();
    expect(await disablePush()).toBe(true);
    expect(pm.current).toBeNull();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(SUBSCRIBE_URL);
    expect(init?.method).toBe("DELETE");
    expect(JSON.parse(String(init?.body))).toEqual({ endpoint: subJson.endpoint });
    expect(await currentPushState()).toBe("off");
  });

  it("syncReminderSettings needs a session", async () => {
    supa.state.session = false;
    expect(await syncReminderSettings(R)).toBe(false);
    expect(supa.state.upserts).toEqual([]);
    supa.state.session = true;
    supa.state.error = { message: "x" };
    expect(await syncReminderSettings(R)).toBe(false);
  });
});
