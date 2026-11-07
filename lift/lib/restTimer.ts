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
  [0, 0.18, 0.36].forEach((d, i) => {
    const o = a.createOscillator();
    const g = a.createGain();
    o.frequency.value = i === 2 ? 1320 : 880;
    g.gain.setValueAtTime(0.0001, t + d);
    g.gain.exponentialRampToValueAtTime(0.4, t + d + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.16);
    o.connect(g).connect(a.destination);
    o.start(t + d);
    o.stop(t + d + 0.18);
    queued.push(o);
  });
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

export const restTimer = {
  start(seconds: number, label = "Rest") {
    unlockAudio();
    fired = false;
    state = { endsAt: Date.now() + seconds * 1000, total: seconds, label };
    scheduleChime(seconds);
    emit();
  },
  add(seconds: number) {
    if (!state) return;
    state = { ...state, endsAt: Math.max(Date.now(), state.endsAt + seconds * 1000), total: Math.max(1, state.total + seconds) };
    fired = false;
    scheduleChime((state.endsAt - Date.now()) / 1000);
    emit();
  },
  stop() {
    state = null;
    cancelQueued();
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
