// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The rest alert has to survive a locked phone or another app in front:
// permission is asked at the first rest, silent audio keeps the page alive, and the notification
// is loud (renotify, not silent) and cleared when the user comes back.
let restTimer: typeof import("../restTimer").restTimer;
const play = vi.fn(async () => {});
const pause = vi.fn();
const requestPermission = vi.fn(async () => "granted");
const show = vi.fn(async () => {});
const close = vi.fn();
let visibility: DocumentVisibilityState = "visible";

class FakeAudio {
  loop = false;
  src: string;
  constructor(src: string) {
    this.src = src;
  }
  play = play;
  pause = pause;
}

function setup(permission: string) {
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("MediaMetadata", class {});
  vi.stubGlobal("Notification", { permission, requestPermission });
  vi.stubGlobal("navigator", {
    mediaSession: { metadata: "unset" },
    serviceWorker: { ready: Promise.resolve({ showNotification: show, getNotifications: async () => [{ close }] }) },
  });
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "blob:silent" });
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
}

beforeEach(async () => {
  vi.useFakeTimers();
  visibility = "visible";
  for (const m of [play, pause, requestPermission, show, close]) m.mockClear();
  ({ restTimer } = await import("../restTimer"));
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

  it("plays looping silent audio while resting so the page is not frozen, and stops it on skip", () => {
    setup("granted");
    restTimer.start(60);
    expect(play).toHaveBeenCalledTimes(1);
    expect(pause).not.toHaveBeenCalled();
    restTimer.stop();
    expect(pause).toHaveBeenCalled();
  });

  it("stops the silent audio shortly after the rest ends", () => {
    setup("granted");
    restTimer.start(10);
    vi.advanceTimersByTime(15000);
    expect(pause).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(pause).toHaveBeenCalledTimes(1);
  });

  it("restarts the keep-alive for the new end time when time is added", () => {
    setup("granted");
    restTimer.start(10);
    restTimer.add(30);
    expect(play).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(20000);
    // The first end time has passed; the extended rest is still being kept alive.
    expect(pause).toHaveBeenCalledTimes(1); // only the replaced element
    vi.advanceTimersByTime(30000);
    expect(pause).toHaveBeenCalledTimes(2);
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
