/**
 * Server-only. Sends one Web Push message with the VAPID keys from the env.
 * Tests swap the sender with setPushSender(); nothing here runs in a test.
 * Never logs keys or subscription secrets.
 */
import { isAllowedPushEndpoint, type PushEnv, type PushSub } from "./endpoint";

export type SendResult = { ok: true } | { ok: false; gone: boolean };
export type PushSender = (sub: PushSub, payload: string) => Promise<SendResult>;

/** Seconds the push service keeps an undelivered reminder. */
export const PUSH_TTL_SEC = 60 * 60;

/** Real sender using the `web-push` package. */
export function webPushSender(env: PushEnv = process.env): PushSender {
  return async (sub, payload) => {
    if (!isAllowedPushEndpoint(sub.endpoint)) return { ok: false, gone: true };
    const webpush = (await import("web-push")).default;
    try {
      await webpush.sendNotification(sub, payload, {
        TTL: PUSH_TTL_SEC,
        vapidDetails: {
          subject: env.VAPID_SUBJECT ?? "",
          publicKey: env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "",
          privateKey: env.VAPID_PRIVATE_KEY ?? "",
        },
      });
      return { ok: true };
    } catch (e) {
      const status = (e as { statusCode?: unknown })?.statusCode;
      // 404 / 410: the subscription expired or was revoked.
      return { ok: false, gone: status === 404 || status === 410 };
    }
  };
}

let override: PushSender | null = null;

/** Test seam: replace the sender; pass null to restore web-push. */
export function setPushSender(next: PushSender | null): void {
  override = next;
}

export function getPushSender(env: PushEnv = process.env): PushSender {
  return override ?? webPushSender(env);
}
