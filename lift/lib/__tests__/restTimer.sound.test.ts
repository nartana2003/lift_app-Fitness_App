import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Issue #5: the end-of-rest chime is queued on the audio clock when the rest starts,
// so it still sounds when page timers are throttled (screen off).
type Osc = { frequency: { value: number }; startAt: number | null; stopped: boolean; connect: () => { connect: () => object }; start: (t: number) => void; stop: (t?: number) => void };
const oscillators: Osc[] = [];
let ctxState: "running" | "suspended" = "running";
const resume = vi.fn(async () => {
  ctxState = "running";
});

class FakeAudioContext {
  currentTime = 100;
  destination = {};
  get state() {
    return ctxState;
  }
  resume = resume;
  createGain() {
    const param = { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} };
    return { gain: param, connect: () => ({}) };
  }
  createOscillator() {
    const o: Osc = {
      frequency: { value: 0 },
      startAt: null,
      stopped: false,
      connect: () => ({ connect: () => ({}) }),
      start: (t) => {
        o.startAt = t;
      },
      // stop(time) ends the note on schedule; stop() with no time is a cancel.
      stop: (t) => {
        if (t === undefined) o.stopped = true;
      },
    };
    oscillators.push(o);
    return o;
  }
}

let restTimer: typeof import("../restTimer").restTimer;

beforeAll(async () => {
  vi.stubGlobal("AudioContext", FakeAudioContext);
  ({ restTimer } = await import("../restTimer"));
});

beforeEach(() => {
  restTimer.stop();
  oscillators.length = 0;
  ctxState = "running";
  resume.mockClear();
});

describe("rest timer chime", () => {
  it("queues a repeating alarm at the end of the rest when it starts", () => {
    restTimer.start(90);
    expect(oscillators).toHaveLength(12);
    expect(oscillators.slice(0, 3).map((o) => o.startAt)).toEqual([190, 190.18, 190.36]);
    expect(oscillators.slice(0, 3).map((o) => o.frequency.value)).toEqual([880, 880, 1320]);
    expect(oscillators[3].startAt).toBeCloseTo(190.9);
  });

  it("cancels the queued notes on stop", () => {
    restTimer.start(60);
    restTimer.stop();
    expect(oscillators.every((o) => o.stopped)).toBe(true);
  });

  it("moves the chime when time is added", () => {
    restTimer.start(60);
    const first = [...oscillators];
    restTimer.add(15);
    expect(first.every((o) => o.stopped)).toBe(true);
    const next = oscillators.slice(12);
    expect(next).toHaveLength(12);
    expect(next[0].startAt).toBeGreaterThan(100 + 74);
    expect(next[0].startAt).toBeLessThanOrEqual(100 + 75);
  });

  it("queues nothing when add is called with no timer", () => {
    restTimer.add(15);
    expect(oscillators).toHaveLength(0);
  });

  it("resumes a suspended audio context", () => {
    restTimer.start(30);
    ctxState = "suspended";
    restTimer.add(10);
    expect(resume).toHaveBeenCalled();
  });
});
