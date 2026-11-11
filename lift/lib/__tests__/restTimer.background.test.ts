// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The rest alert has to survive a locked phone or another app in front:
// permission is asked at the first rest, silent audio keeps the page alive, and the notification
// is loud (renotify, not silent) and cleared when the user comes back.
let restTimer: typeof import("../restTimer").restTimer;
let alarmWav: typeof import("../restTimer").alarmWav;
const play = vi.fn<() => Promise<void>>(async () => {});
const pause = vi.fn();
const requestPermission = vi.fn(async () => "granted");
const show = vi.fn(async () => {});
const close = vi.fn();
let visibility: DocumentVisibilityState = "visible";

const notes: number[] = [];
class FakeAudioContext {
  currentTime = 0;
  state = "running";
  destination = {};
  resume = async () => {};
  createGain() {
    return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: () => ({}) };
  }
  createOscillator() {
    return { frequency: { value: 0 }, connect: () => ({ connect: () => ({}) }), start: (t: number) => notes.push(t), stop() {} };
  }
}

const srcs: string[] = [];
class FakeAudio {
  loop = false;
  onended: (() => void) | null = null;
  set src(v: string) {
    srcs.push(v);
  }
  play = play;
  pause = pause;
}

function setup(permission: string) {
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("MediaMetadata", class {});
  vi.stubGlobal("Notification", { permission, requestPermission });
  vi.stubGlobal("navigator", {
    mediaSession: { metadata: "unset" },
    serviceWorker: { ready: Promise.resolve({ showNotification: show, getNotifications: async () => [{ close }] }) },
  });
  let n = 0;
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => `blob:alarm-${++n}` });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => {} });
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
}

beforeEach(async () => {
  vi.useFakeTimers();
  visibility = "visible";
  for (const m of [play, pause, requestPermission, show, close]) m.mockClear();
  play.mockImplementation(async () => {});
  srcs.length = 0;
  notes.length = 0;
  ({ restTimer, alarmWav } = await import("../restTimer"));
});

afterEach(() => {
  restTimer.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("rest timer in the background", () => {
  it("asks for notification permission the first time a rest starts", () => {
    setup("default");
    restTimer.start(60);
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it("does not ask again once permission is decided", () => {
    setup("granted");
    restTimer.start(60);
    setup("denied");
    restTimer.start(60);
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("plays the whole rest as one audio file, so no page timer is needed to sound the alarm", () => {
    setup("granted");
    restTimer.start(60);
    expect(play).toHaveBeenCalledTimes(1);
    expect(srcs).toEqual(["blob:alarm-1"]);
    // The file carries the alarm, so the chime is not also queued.
    expect(notes).toHaveLength(0);
  });

  it("stops the audio on skip", () => {
    setup("granted");
    restTimer.start(60);
    const before = pause.mock.calls.length;
    restTimer.stop();
    expect(pause.mock.calls.length).toBeGreaterThan(before);
  });

  it("builds a new file for the new end time when time is added", () => {
    setup("granted");
    restTimer.start(10);
    const before = pause.mock.calls.length;
    restTimer.add(30);
    expect(play).toHaveBeenCalledTimes(2);
    expect(srcs).toEqual(["blob:alarm-1", "blob:alarm-2"]);
    expect(pause.mock.calls.length).toBeGreaterThan(before); // the first file is stopped
  });

  it("queues the chime on the audio clock when the phone blocks playback", async () => {
    setup("granted");
    play.mockRejectedValue(new Error("NotAllowedError"));
    restTimer.start(30);
    await vi.advanceTimersByTimeAsync(0);
    expect(notes).toHaveLength(12);
  });

  it("uses the chime for a rest too long to render as a file", () => {
    setup("granted");
    restTimer.start(1200);
    expect(play).not.toHaveBeenCalled();
    expect(notes).toHaveLength(12);
  });

  it("shows a notification that sounds and vibrates when hidden at the end", async () => {
    setup("granted");
    visibility = "hidden";
    restTimer.start(5);
    await vi.advanceTimersByTimeAsync(6000);
    expect(show).toHaveBeenCalledWith("Rest over", expect.objectContaining({ tag: "lift-rest", renotify: true, silent: false, vibrate: [200, 100, 200], requireInteraction: true }));
  });

  it("clears the notification when the user comes back to the app", async () => {
    setup("granted");
    restTimer.start(60);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(close).toHaveBeenCalled();
  });

  it("still works when the browser has no audio element or notifications", () => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("Audio", undefined);
    expect(() => {
      restTimer.start(5);
      restTimer.add(5);
      restTimer.stop();
    }).not.toThrow();
  });
});

describe("alarmWav", () => {
  it("is a valid 8-bit mono WAV with silence for the rest, then the alarm", () => {
    const b = alarmWav(2);
    const text = (o: number, n: number) => String.fromCharCode(...b.slice(o, o + n));
    expect(text(0, 4)).toBe("RIFF");
    expect(text(8, 8)).toBe("WAVEfmt ");
    expect(text(36, 4)).toBe("data");
    expect(b.length).toBe(44 + 6 * 8000);
    const dv = new DataView(b.buffer);
    expect(dv.getUint32(4, true)).toBe(b.length - 8);
    expect(dv.getUint32(40, true)).toBe(6 * 8000);
    expect(dv.getUint32(24, true)).toBe(8000);
    const silence = b.slice(44, 44 + 2 * 8000);
    expect(silence.every((v) => v === 128)).toBe(true);
    const alarm = b.slice(44 + 2 * 8000);
    expect(alarm.some((v) => v !== 128)).toBe(true);
    // The alarm is 12 notes in four bursts: sound in each burst, gaps between.
    const loud = (from: number, to: number) => alarm.slice(Math.round(from * 8000), Math.round(to * 8000)).some((v) => Math.abs(v - 128) > 40);
    expect([0, 0.9, 1.8, 2.7].every((t) => loud(t, t + 0.5))).toBe(true);
    expect(loud(0.7, 0.88)).toBe(false);
  });

  it("is just the alarm when there is no rest left", () => {
    expect(alarmWav(0).length).toBe(44 + 4 * 8000);
  });
});
