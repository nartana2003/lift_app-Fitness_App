// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applySwaps, loadSwaps, saveSwap, swapKey } from "../catchUpSwaps";

const WEEK = "2026-10-12";
const SAT = "2026-10-17";
const add = (exercise_id: string, sets = 3, date = SAT) => ({ exercise_id, date, sets, muscle: "Biceps", reason: "Brings Biceps to target", in_routine: false });

beforeEach(() => localStorage.clear());

describe("catch-up swaps storage", () => {
  it("remembers a pick for the week and nothing for another week", () => {
    saveSwap(WEEK, SAT, "curl", "hammer-curl");
    expect(loadSwaps(WEEK)).toEqual({ [swapKey(SAT, "curl")]: "hammer-curl" });
    expect(loadSwaps("2026-10-19")).toEqual({});
  });

  it("picking the original back removes the swap", () => {
    saveSwap(WEEK, SAT, "curl", "hammer-curl");
    saveSwap(WEEK, SAT, "curl", "curl");
    expect(loadSwaps(WEEK)).toEqual({});
  });

  it("a second pick for the same suggestion replaces the first", () => {
    saveSwap(WEEK, SAT, "curl", "hammer-curl");
    saveSwap(WEEK, SAT, "curl", "preacher");
    expect(loadSwaps(WEEK)).toEqual({ [swapKey(SAT, "curl")]: "preacher" });
  });

  it("survives broken storage", () => {
    localStorage.setItem("lift.catchUpSwaps", "{not json");
    expect(loadSwaps(WEEK)).toEqual({});
  });
});

describe("applySwaps", () => {
  it("replaces the exercise but keeps its muscle and sets, and remembers the original", () => {
    const out = applySwaps([add("curl", 3)], { [swapKey(SAT, "curl")]: "hammer-curl" });
    expect(out).toEqual([{ ...add("hammer-curl", 3), orig: "curl", reason: "Your pick for Biceps" }]);
  });

  it("leaves other items and other days alone", () => {
    const list = [add("curl"), add("dip"), add("curl", 3, "2026-10-18")];
    const out = applySwaps(list, { [swapKey(SAT, "curl")]: "hammer-curl" });
    expect(out.map((a) => `${a.date}|${a.exercise_id}`)).toEqual([`${SAT}|hammer-curl`, `${SAT}|dip`, "2026-10-18|curl"]);
  });

  it("merges into an exercise already on that day instead of listing it twice", () => {
    const out = applySwaps([add("dip", 3), add("curl", 3)], { [swapKey(SAT, "curl")]: "dip" });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ exercise_id: "dip", sets: 6 });
  });

  it("merges when the pick is listed later on the same day", () => {
    const out = applySwaps([add("curl", 3), add("dip", 3)], { [swapKey(SAT, "curl")]: "dip" });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ exercise_id: "dip", sets: 6 });
  });

  it("changes nothing without swaps", () => {
    const list = [add("curl")];
    expect(applySwaps(list, {})).toEqual(list);
  });
});

describe("scroll memory", () => {
  it("restores the remembered position once, then forgets it", async () => {
    const { rememberScroll, restoreScroll } = await import("../catchUpSwaps");
    const store = new Map<string, string>();
    const to = vi.fn();
    vi.stubGlobal("sessionStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) });
    vi.stubGlobal("window", { scrollY: 640, scrollTo: to });
    rememberScroll();
    restoreScroll();
    expect(to).toHaveBeenCalledWith(0, 640);
    to.mockClear();
    restoreScroll();
    expect(to).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
