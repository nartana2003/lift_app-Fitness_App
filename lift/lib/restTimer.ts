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

const RATE = 8000;
/** The alarm is the three-note chime four times over, about 3.6 s. */
const ALARM_SEC = 4;
/** Longest rest played as one audio file; longer ones use the chime queued on the audio clock. */
const MAX_FILE_SEC = 900;

/** WAV bytes (8 kHz, 8-bit mono): `lead` seconds of silence, then the alarm. */
export function alarmWav(lead: number): Uint8Array {
  const n = Math.round((lead + ALARM_SEC) * RATE);
  const b = new Uint8Array(44 + n).fill(128);
  const dv = new DataView(b.buffer);
  const str = (o: number, t: string) => [...t].forEach((c, i) => (b[o + i] = c.charCodeAt(0)));
  str(0, "RIFF");
  dv.setUint32(4, 36 + n, true);
  str(8, "WAVEfmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, RATE, true);
  dv.setUint32(28, RATE, true);
  dv.setUint16(32, 1, true);
  dv.setUint16(34, 8, true);
  str(36, "data");
  dv.setUint32(40, n, true);
  for (let r = 0; r < 4; r++) {
    [0, 0.18, 0.36].forEach((note, i) => {
      const start = Math.round((lead + r * 0.9 + note) * RATE);
      const len = Math.round(0.16 * RATE);
      const hz = i === 2 ? 1320 : 880;
      for (let k = 0; k < len; k++) {
        const t = k / RATE;
        const env = Math.min(1, t / 0.02) * Math.min(1, (0.16 - t) / 0.04);
        const sq = Math.sin(2 * Math.PI * hz * t) >= 0 ? 1 : -1;
        b[44 + start + k] = 128 + Math.round(sq * env * 0.8 * 127);
      }
    });
  }
  return b;
}

// One audio element is reused, so a phone that unlocked it with the first tap keeps it unlocked.
let el: HTMLAudioElement | null = null;
let elUrl: string | undefined;

function stopAlarmFile() {
  try {
    el?.pause();
    if (elUrl) URL.revokeObjectURL(elUrl);
    if (typeof navigator !== "undefined" && "mediaSession" in navigator) navigator.mediaSession.metadata = null;
  } catch {}
  elUrl = undefined;
}

/**
 * Play the whole rest as one audio file: silence for the rest, then the alarm. An audio element
 * is not muted by the phone's silent switch the way Web Audio is, keeps playing when the phone
 * locks or another app is in front, and needs no page timer to fire at the end.
 * Returns false when it cannot be used; true means it started (a blocked play falls back to the chime).
 */
function playAlarmFile(seconds: number): boolean {
  stopAlarmFile();
  try {
    if (typeof Audio === "undefined" || typeof URL === "undefined" || seconds > MAX_FILE_SEC) return false;
    el ??= new Audio();
    elUrl = URL.createObjectURL(new Blob([alarmWav(Math.max(0, seconds)) as BlobPart], { type: "audio/wav" }));
    el.src = elUrl;
    el.loop = false;
    el.onended = stopAlarmFile;
    void Promise.resolve(el.play()).catch(() => {
      // Blocked or unsupported: queue the chime on the audio clock instead.
      if (state) scheduleChime((state.endsAt - Date.now()) / 1000);
    });
    if ("mediaSession" in navigator && typeof MediaMetadata !== "undefined") navigator.mediaSession.metadata = new MediaMetadata({ title: "Rest timer", artist: "Lift" });
    return true;
  } catch {
    return false;
  }
}

/** Sound the end of the rest: the audio file where possible, else the chime queued on the audio clock. */
function scheduleAlarm(seconds: number) {
  cancelQueued();
  if (playAlarmFile(seconds)) scheduled = true;
  else scheduleChime(seconds);
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
    fired = false;
    state = { endsAt: Date.now() + seconds * 1000, total: seconds, label };
    scheduleAlarm(seconds);
    scheduleNotify(seconds);
    emit();
  },
  add(seconds: number) {
    if (!state) return;
    state = { ...state, endsAt: Math.max(Date.now(), state.endsAt + seconds * 1000), total: Math.max(1, state.total + seconds) };
    fired = false;
    scheduleAlarm((state.endsAt - Date.now()) / 1000);
    scheduleNotify((state.endsAt - Date.now()) / 1000);
    emit();
  },
  stop() {
    state = null;
    cancelQueued();
    clearTimeout(notifyTimer);
    stopAlarmFile();
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
