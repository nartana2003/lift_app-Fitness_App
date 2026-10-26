import { afterEach, describe, expect, it, vi } from "vitest";

// web-push is mocked: nothing is ever sent.
const wp = vi.hoisted(() => ({ calls: [] as unknown[][], fail: null as null | { statusCode: number } }));
vi.mock("web-push", () => ({
  default: {
    sendNotification: async (...args: unknown[]) => {
      wp.calls.push(args);
      if (wp.fail) throw wp.fail;
      return { statusCode: 201 };
    },
  },
}));

const { getPushSender, setPushSender, webPushSender, PUSH_TTL_SEC } = await import("../send");

const P256 = "B" + "A".repeat(86);
const AUTH = "a".repeat(22);
const SUB = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: P256, auth: AUTH } };
const ENV = { NEXT_PUBLIC_VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv", VAPID_SUBJECT: "mailto:a@b.c" };

afterEach(() => {
  wp.calls.length = 0;
  wp.fail = null;
  setPushSender(null);
});

describe("webPushSender", () => {
  it("sends with the VAPID details and a TTL", async () => {
    expect(await webPushSender(ENV)(SUB, "{}")).toEqual({ ok: true });
    const [sub, payload, opts] = wp.calls[0] as [unknown, string, { TTL: number; vapidDetails: Record<string, string> }];
    expect(sub).toEqual(SUB);
    expect(payload).toBe("{}");
    expect(opts.TTL).toBe(PUSH_TTL_SEC);
    expect(opts.vapidDetails).toEqual({ subject: "mailto:a@b.c", publicKey: "pub", privateKey: "priv" });
  });

  it("404/410 mean gone, other failures are not", async () => {
    wp.fail = { statusCode: 410 };
    expect(await webPushSender(ENV)(SUB, "{}")).toEqual({ ok: false, gone: true });
    wp.fail = { statusCode: 404 };
    expect(await webPushSender(ENV)(SUB, "{}")).toEqual({ ok: false, gone: true });
    wp.fail = { statusCode: 500 };
    expect(await webPushSender(ENV)(SUB, "{}")).toEqual({ ok: false, gone: false });
  });

  it("never posts to a host that is not a push service", async () => {
    expect(await webPushSender(ENV)({ ...SUB, endpoint: "https://169.254.169.254/x" }, "{}")).toEqual({ ok: false, gone: true });
    expect(wp.calls).toEqual([]);
  });

  it("setPushSender swaps the sender", async () => {
    const fake = vi.fn(async () => ({ ok: true as const }));
    setPushSender(fake);
    expect(getPushSender(ENV)).toBe(fake);
    setPushSender(null);
    expect(getPushSender(ENV)).not.toBe(fake);
  });
});
