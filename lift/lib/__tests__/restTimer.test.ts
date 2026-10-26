import { beforeEach, describe, expect, it } from "vitest";
import { fmtClock, restTimer } from "../restTimer";

beforeEach(() => {
  restTimer.stop();
});

describe("rest timer store", () => {
  it("starts with an end time, total and label", () => {
    const before = Date.now();
    restTimer.start(90, "Bench press");
    const s = restTimer.get()!;
    expect(s.total).toBe(90);
    expect(s.label).toBe("Bench press");
    expect(s.endsAt).toBeGreaterThanOrEqual(before + 90_000);
    expect(s.endsAt).toBeLessThanOrEqual(Date.now() + 90_000);
  });

  it("labels the timer Rest by default", () => {
    restTimer.start(60);
    expect(restTimer.get()!.label).toBe("Rest");
  });

  it("adds and removes time", () => {
    restTimer.start(60);
    const end = restTimer.get()!.endsAt;
    restTimer.add(15);
    expect(restTimer.get()!.endsAt).toBe(end + 15_000);
    expect(restTimer.get()!.total).toBe(75);
    restTimer.add(-30);
    expect(restTimer.get()!.endsAt).toBe(end - 15_000);
    expect(restTimer.get()!.total).toBe(45);
  });

  it("never pushes the end into the past or the total below 1", () => {
    restTimer.start(10);
    const before = Date.now();
    restTimer.add(-600);
    const s = restTimer.get()!;
    expect(s.endsAt).toBeGreaterThanOrEqual(before);
    expect(s.total).toBe(1);
  });

  it("ignores add when no timer is running", () => {
    restTimer.add(30);
    expect(restTimer.get()).toBeNull();
  });

  it("clears on stop", () => {
    restTimer.start(60);
    restTimer.stop();
    expect(restTimer.get()).toBeNull();
  });

  it("notifies subscribers on every change until unsubscribed", () => {
    let calls = 0;
    const unsubscribe = restTimer.subscribe(() => calls++);
    restTimer.start(30);
    restTimer.add(10);
    restTimer.stop();
    expect(calls).toBe(3);
    unsubscribe();
    restTimer.start(30);
    expect(calls).toBe(3);
  });
});

describe("clock format", () => {
  it("renders m:ss", () => {
    expect(fmtClock(0)).toBe("0:00");
    expect(fmtClock(5)).toBe("0:05");
    expect(fmtClock(60)).toBe("1:00");
    expect(fmtClock(95)).toBe("1:35");
    expect(fmtClock(600)).toBe("10:00");
  });
});
