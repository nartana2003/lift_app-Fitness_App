"use client";

// Tiny global store for the rest countdown. Survives reloads via localStorage.
import { useEffect, useState, useSyncExternalStore } from "react";

type State = { endsAt: number; total: number; label: string } | null;

const LS = "lift:rest";
let state: State = null;
const listeners = new Set<() => void>();
let audio: AudioContext | null = null;
let fired = false;
/** True when the end-of-rest chime is already queued on the audio clock. */
let scheduled = false;

function load() {
  if (typeof window === "undefined") return;
  try {
    const raw = localStorage.getItem(LS);
    state = raw ? JSON.parse(raw) : null;
    if (state && state.endsAt < Date.now() - 5000) state = null;
  } catch {
    state = null;
  }
}
load();

function emit() {
  try {
    if (state) localStorage.setItem(LS, JSON.stringify(state));
    else localStorage.removeItem(LS);
  } catch {}
  listeners.forEach((l) => l());
}

/** Must be called from a user gesture once so iOS lets us play sound later. */
function unlockAudio() {
  try {
    audio ??= new AudioContext();
    if (audio.state === "suspended") void audio.resume();
  } catch {}
}

/** Oscillators queued on the audio clock for the running rest, so they can be cancelled. */
let queued: OscillatorNode[] = [];

function cancelQueued() {
  for (const o of queued) {
    try {
      o.stop();
    } catch {}
  }
  queued = [];
}

/** Play the three-note chime `delay` seconds from now. Returns false when no sound can be queued. */
function chime(delay = 0): boolean {
  if (!audio) return false;
  if (audio.state === "suspended") void audio.resume().catch(() => {});
  const a = audio;
  const t = a.currentTime + delay;
  // Alarm: the three-note chime repeated, so it is hard to miss.
  for (let r = 0; r < 4; r++) {
    [0, 0.18, 0.36].forEach((n, i) => {
      const d = r * 0.9 + n;
      const o = a.createOscillator();
      const g = a.createGain();
      o.type = "square";
      o.frequency.value = i === 2 ? 1320 : 880;
      g.gain.setValueAtTime(0.0001, t + d);
      g.gain.exponentialRampToValueAtTime(0.5, t + d + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.16);
      o.connect(g).connect(a.destination);
      o.start(t + d);
      o.stop(t + d + 0.18);
      queued.push(o);
    });
  }
  return a.state === "running";
}

/**
 * Queue the chime on the audio clock for when the rest ends. The audio thread keeps time
 * when the page's timers are throttled (screen off, another app in front).
 */
function scheduleChime(seconds: number) {
  cancelQueued();
  scheduled = chime(Math.max(0, seconds));
}

let notifyTimer: ReturnType<typeof setTimeout> | undefined;

/** Ask once, from the tap that starts a rest, so the "rest over" alert can reach a locked or backgrounded phone. */
function askNotifyPermission() {
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "default" && typeof Notification.requestPermission === "function") {
      void Promise.resolve(Notification.requestPermission()).catch(() => {});
    }
  } catch {}
}

/** One second of silence as a WAV, built once. */
let silentUrl: string | undefined;
function silentWavUrl(): string {
  if (silentUrl) return silentUrl;
  const rate = 8000;
  const b = new Uint8Array(44 + rate).fill(128);
  const dv = new DataView(b.buffer);
  const str = (o: number, t: string) => [...t].forEach((c, i) => (b[o + i] = c.charCodeAt(0)));
  str(0, "RIFF");
  dv.setUint32(4, 36 + rate, true);
  str(8, "WAVEfmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate, true);
  dv.setUint16(32, 1, true);
  dv.setUint16(34, 8, true);
  str(36, "data");
  dv.setUint32(40, rate, true);
  return (silentUrl = URL.createObjectURL(new Blob([b], { type: "audio/wav" })));
}

let keep: HTMLAudioElement | null = null;
let keepTimer: ReturnType<typeof setTimeout> | undefined;

function stopKeepAwake() {
  clearTimeout(keepTimer);
  try {
    keep?.pause();
    if (typeof navigator !== "undefined" && "mediaSession" in navigator) navigator.mediaSession.metadata = null;
  } catch {}
  keep = null;
}

/**
 * Plays silence while a rest runs. A page that is playing audio is not frozen when the phone
 * locks or another app is in front, so the end-of-rest chime and notification still fire on time.
 * Stops shortly after the rest ends.
 */
function keepAwake(seconds: number) {
  stopKeepAwake();
  try {
    if (typeof Audio === "undefined") return;
    keep = new Audio(silentWavUrl());
    keep.loop = true;
    void Promise.resolve(keep.play()).catch(() => {});
    if ("mediaSession" in navigator && typeof MediaMetadata !== "undefined") navigator.mediaSession.metadata = new MediaMetadata({ title: "Rest timer", artist: "Lift" });
  } catch {}
  keepTimer = setTimeout(stopKeepAwake, (Math.max(0, seconds) + 6) * 1000);
}

/** Remove a "rest over" notification that is still showing. */
function closeNotice() {
  try {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.ready
      .then((r) => r.getNotifications({ tag: "lift-rest" }))
      .then((list) => list.forEach((n) => n.close()))
      .catch(() => {});
  } catch {}
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    closeNotice();
    // Coming back, wake an audio context the phone suspended while the page was away.
    if (state && audio && audio.state !== "running") void audio.resume().catch(() => {});
  });
}

/** Local "rest over" notification for when the page is in the background and push is not in play. */
function notifyDone() {
  try {
    if (typeof document === "undefined" || document.visibilityState !== "hidden") return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    // The phone plays its notification sound for this; vibrate and renotify make a repeat tag alert again.
    const opts = { body: "Time for your next set.", tag: "lift-rest", data: { url: "/workout" }, requireInteraction: true, renotify: true, silent: false, vibrate: [200, 100, 200] };
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.ready.then((r) => r.showNotification("Rest over", opts)).catch(() => {});
    } else new Notification("Rest over", opts);
  } catch {}
}

function scheduleNotify(seconds: number) {
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(notifyDone, Math.max(0, seconds) * 1000);
}

export const restTimer = {
  start(seconds: number, label = "Rest") {
    unlockAudio();
    askNotifyPermission();
    keepAwake(seconds);
    fired = false;
    state = { endsAt: Date.now() + seconds * 1000, total: seconds, label };
    scheduleChime(seconds);
    scheduleNotify(seconds);
    emit();
  },
  add(seconds: number) {
    if (!state) return;
    state = { ...state, endsAt: Math.max(Date.now(), state.endsAt + seconds * 1000), total: Math.max(1, state.total + seconds) };
    fired = false;
    scheduleChime((state.endsAt - Date.now()) / 1000);
    scheduleNotify((state.endsAt - Date.now()) / 1000);
    keepAwake((state.endsAt - Date.now()) / 1000);
    emit();
  },
  stop() {
    state = null;
    cancelQueued();
    clearTimeout(notifyTimer);
    stopKeepAwake();
    closeNotice();
    scheduled = false;
    emit();
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  get: () => state,
};

/** Current timer + seconds remaining (ticks every 250ms while running). Fires the chime once at 0. */
export function useRestTimer() {
  const s = useSyncExternalStore(restTimer.subscribe, restTimer.get, () => null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!s) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [s]);
  const remaining = s ? Math.max(0, Math.ceil((s.endsAt - now) / 1000)) : 0;
  useEffect(() => {
    if (s && remaining === 0 && !fired) {
      fired = true;
      // Already queued on the audio clock: only play now if that could not be done.
      if (!scheduled) chime();
      try {
        navigator.vibrate?.([200, 100, 200]);
      } catch {}
    }
  }, [s, remaining]);
  return { timer: s, remaining };
}

export const fmtClock = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
