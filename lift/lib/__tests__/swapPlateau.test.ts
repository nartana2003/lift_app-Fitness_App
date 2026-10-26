import { describe, expect, it } from "vitest";
import catalogue from "../../data/exercises.json";
import type { Exercise } from "../exercises";
import { swapOptions } from "../swap";
import { detectPlateau, type SessionPoint } from "../plateau";

const all = catalogue as unknown as Exercise[];
const byName = (n: string) => all.find((e) => e.name === n)!;

describe("swapOptions", () => {
  const legPress = byName("Leg Press");

  it("suggests exercises for the same muscle", () => {
    const picks = swapOptions(all, legPress, "variety", 5);
    expect(picks.length).toBe(5);
    expect(picks.every((p) => p.muscle_groups.some((m) => legPress.muscle_groups.includes(m)))).toBe(true);
    expect(picks.every((p) => p.id !== legPress.id)).toBe(true);
  });

  it("'machine busy' avoids machines", () => {
    const picks = swapOptions(all, legPress, "busy", 5);
    expect(picks.filter((p) => p.equipment === "Machine/Cable")).toHaveLength(0);
  });

  it("'no equipment' prefers bodyweight, dumbbells or bands", () => {
    const picks = swapOptions(all, byName("Barbell Squat"), "equipment", 4);
    expect(picks.every((p) => ["Bodyweight", "Dumbbell", "Bands"].includes(p.equipment))).toBe(true);
  });

  it("'it hurts' leans towards machines and cables", () => {
    const picks = swapOptions(all, byName("Barbell Squat"), "hurts", 4);
    expect(picks.some((p) => p.equipment === "Machine/Cable")).toBe(true);
  });
});

describe("detectPlateau", () => {
  const day = 864e5;
  const now = new Date("2026-10-15T12:00:00Z");
  const ago = (days: number) => new Date(now.getTime() - days * day).toISOString();
  const session = (daysAgo: number, weight: number, reps = 5): SessionPoint => ({
    date: ago(daysAgo),
    sets: [{ reps, weight }],
  });

  it("flags a lift stuck for several weeks", () => {
    const p = detectPlateau("bench", [session(28, 100), session(21, 100), session(14, 100), session(3, 100)], { now });
    expect(p).toMatchObject({ exerciseId: "bench", sessions: 4 });
    expect(p!.weeks).toBeGreaterThanOrEqual(3);
    expect(p!.advice).toBeTruthy();
  });

  it("doesn't flag a lift that is still improving", () => {
    expect(detectPlateau("bench", [session(28, 100), session(21, 102.5), session(14, 105), session(3, 107.5)], { now })).toBeNull();
  });

  it("needs at least three sessions", () => {
    expect(detectPlateau("bench", [session(28, 100), session(3, 100)], { now })).toBeNull();
  });

  it("ignores lifts not trained recently", () => {
    expect(detectPlateau("bench", [session(90, 100), session(80, 100), session(70, 100)], { now })).toBeNull();
  });

  it("ignores warm-ups and empty sets", () => {
    const s: SessionPoint[] = [
      { date: ago(28), sets: [{ reps: 10, weight: 200, is_warmup: true }, { reps: 5, weight: 100 }] },
      { date: ago(21), sets: [{ reps: 5, weight: 100 }] },
      { date: ago(14), sets: [{ reps: 5, weight: 100 }] },
      { date: ago(2), sets: [{ reps: 5, weight: 100 }, { reps: 0, weight: 0 }] },
    ];
    const p = detectPlateau("bench", s, { now });
    expect(p!.bestE1rm).toBe(116.7); // from the 100kg working set, not the 200kg warm-up
  });

  it("gives stronger advice the longer the stall", () => {
    const long = detectPlateau("bench", [session(60, 100), session(40, 100), session(20, 100), session(1, 100)], { now });
    expect(long!.advice).toMatch(/lighter week/i);
  });
});
