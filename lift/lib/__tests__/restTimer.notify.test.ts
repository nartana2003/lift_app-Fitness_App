// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Issue #33: a local "rest over" notification when the page is in the background.
let restTimer: typeof import("../restTimer").restTimer;
const show = vi.fn(async () => {});

function setup(visibility: "hidden" | "visible", permission = "granted") {
  vi.stubGlobal("Notification", { permission });
  vi.stubGlobal("navigator", { serviceWorker: { ready: Promise.resolve({ showNotification: show }) } });
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(visibility);
}

beforeEach(async () => {
  vi.useFakeTimers();
  show.mockClear();
  ({ restTimer } = await import("../restTimer"));
});

afterEach(() => {
  restTimer.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("rest timer background notification", () => {
  it("notifies at the end of rest when the page is hidden", async () => {
    setup("hidden");
    restTimer.start(30);
    vi.advanceTimersByTime(29000);
    expect(show).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500);
    expect(show).toHaveBeenCalledWith("Rest over", expect.objectContaining({ tag: "lift-rest" }));
  });

  it("does not notify when the page is visible", async () => {
    setup("visible");
    restTimer.start(5);
    await vi.advanceTimersByTimeAsync(6000);
    expect(show).not.toHaveBeenCalled();
  });

  it("does not notify without permission", async () => {
    setup("hidden", "default");
    restTimer.start(5);
    await vi.advanceTimersByTimeAsync(6000);
    expect(show).not.toHaveBeenCalled();
  });

  it("does not notify after the rest is skipped", async () => {
    setup("hidden");
    restTimer.start(5);
    restTimer.stop();
    await vi.advanceTimersByTimeAsync(6000);
    expect(show).not.toHaveBeenCalled();
  });
});
