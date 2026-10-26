import { describe, expect, it } from "vitest";
import { adminConfiguredFrom, isAllowedPushEndpoint, isPushKeys, toPushSub, urlBase64ToUint8Array, vapidConfiguredFrom } from "../endpoint";

const P256 = "B" + "A".repeat(86); // 87 chars, base64url
const AUTH = "a".repeat(22);

describe("isAllowedPushEndpoint", () => {
  it.each([
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://web.push.apple.com/QGx",
    "https://api.push.apple.com/x",
    "https://updates.push.services.mozilla.com/wpush/v2/x",
    "https://wns2-par02p.notify.windows.com/w/?token=x",
  ])("accepts %s", (u) => expect(isAllowedPushEndpoint(u)).toBe(true));

  it.each([
    "http://fcm.googleapis.com/fcm/send/abc",
    "https://evil.example/fcm.googleapis.com",
    "https://fcm.googleapis.com.evil.example/x",
    "https://push.apple.com/x",
    "https://evilpush.apple.com.attacker.io/x",
    "https://user:pw@fcm.googleapis.com/x",
    "https://fcm.googleapis.com:8443/x",
    "https://169.254.169.254/latest",
    "https://localhost/x",
    "not a url",
    "",
    `https://fcm.googleapis.com/${"a".repeat(2000)}`,
    42,
    null,
  ])("rejects %j", (u) => expect(isAllowedPushEndpoint(u)).toBe(false));
});

describe("keys and subscription", () => {
  it("validates key sizes and charset, no extra keys", () => {
    expect(isPushKeys({ p256dh: P256, auth: AUTH })).toBe(true);
    expect(isPushKeys({ p256dh: P256, auth: "short" })).toBe(false);
    expect(isPushKeys({ p256dh: P256.slice(0, 40), auth: AUTH })).toBe(false);
    expect(isPushKeys({ p256dh: P256, auth: "<script>alert(1)</script>xx" })).toBe(false);
    expect(isPushKeys({ p256dh: P256, auth: AUTH, extra: "x" })).toBe(false);
    expect(isPushKeys([P256, AUTH])).toBe(false);
  });

  it("toPushSub keeps only the clean fields", () => {
    const sub = toPushSub({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: P256, auth: AUTH }, junk: 1 });
    expect(sub).toEqual({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: P256, auth: AUTH } });
    expect(toPushSub({ endpoint: "https://evil.example/", keys: { p256dh: P256, auth: AUTH } })).toBeNull();
    expect(toPushSub(null)).toBeNull();
  });
});

describe("config", () => {
  it("needs all three VAPID values", () => {
    expect(vapidConfiguredFrom({ NEXT_PUBLIC_VAPID_PUBLIC_KEY: "p", VAPID_PRIVATE_KEY: "k", VAPID_SUBJECT: "mailto:a@b.c" })).toBe(true);
    expect(vapidConfiguredFrom({ NEXT_PUBLIC_VAPID_PUBLIC_KEY: "p", VAPID_PRIVATE_KEY: " ", VAPID_SUBJECT: "mailto:a@b.c" })).toBe(false);
    expect(vapidConfiguredFrom({})).toBe(false);
  });

  it("needs a real URL and the service-role key", () => {
    expect(adminConfiguredFrom({ NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "s" })).toBe(true);
    expect(adminConfiguredFrom({ NEXT_PUBLIC_SUPABASE_URL: "https://YOUR-PROJECT.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "s" })).toBe(false);
    expect(adminConfiguredFrom({ NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co" })).toBe(false);
  });
});

describe("urlBase64ToUint8Array", () => {
  it("decodes base64url without padding", () => {
    expect([...urlBase64ToUint8Array("AQID_-8")]).toEqual([1, 2, 3, 255, 239]);
    expect(urlBase64ToUint8Array(P256)).toHaveLength(65);
  });
});
