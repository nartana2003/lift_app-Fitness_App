"use client";

/**
 * Browser side of the rest-timer push (see lib/restTimerPush.ts). The opt-in
 * is per phone (localStorage), because the push goes to this phone's
 * subscription. Without push support, a subscription or a server, nothing is
 * sent and the in-app timer (lib/restTimer.ts) is the only alert.
 */

import { useEffect, useSyncExternalStore } from "react";
import { pushAvailable } from "@/lib/push/client";
import { restTimer } from "@/lib/restTimer";
import { createRestTimerPushController, REST_PUSH_LS, type RestPushController } from "@/lib/restTimerPush";

const listeners = new Set<() => void>();

/** True when the user turned rest-timer alerts on for this phone. */
export function restPushEnabled(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(REST_PUSH_LS) === "1";
  } catch {
    return false;
  }
}

export function setRestPushEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(REST_PUSH_LS, "1");
    else localStorage.removeItem(REST_PUSH_LS);
  } catch {}
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** Opt-in state for the Reminders toggle. */
export function useRestPushEnabled(): boolean {
  return useSyncExternalStore(subscribe, restPushEnabled, () => false);
}

/** This phone's push subscription endpoint, or null (no service worker within 1.5s, or not subscribed). */
async function subscriptionEndpoint(): Promise<string | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((r) => (timer = setTimeout(() => r(null), 1500)));
  try {
    const reg = await Promise.race([navigator.serviceWorker.ready, timeout]);
    const sub = await reg?.pushManager.getSubscription();
    return sub?.endpoint ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let controller: RestPushController | null = null;

function getController(): RestPushController {
  controller ??= createRestTimerPushController({
    enabled: restPushEnabled,
    available: pushAvailable,
    hidden: () => typeof document !== "undefined" && document.visibilityState === "hidden",
    timer: () => restTimer.get(),
    endpoint: subscriptionEndpoint,
    fetch: (url, init) => fetch(url, init),
    now: Date.now,
  });
  return controller;
}

/**
 * Mount once on the live workout (components/RestTimer.tsx). Schedules the
 * push when the page hides with a timer running and cancels it when the page
 * shows again or the timer stops or changes.
 */
export function useRestTimerPush(): void {
  useEffect(() => {
    if (typeof document === "undefined") return;
    const c = getController();
    const sync = () => void c.sync();
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("pagehide", sync);
    const offTimer = restTimer.subscribe(sync);
    const offToggle = subscribe(sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("pagehide", sync);
      offTimer();
      offToggle();
    };
  }, []);
}
