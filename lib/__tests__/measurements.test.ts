import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../offline/db";
import {
  bmi,
  bmiLabel,
  deleteMeasurement,
  latestMeasurement,
  MEASUREMENTS,
  measurementSeries,
  saveMeasurement,
  todayISO,
} from "../measurements";

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe("measurement catalogue", () => {
  it("has unique keys, each with a label and unit", () => {
    const keys = MEASUREMENTS.map((m) => m.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const m of MEASUREMENTS) {
      expect(m.label.length).toBeGreaterThan(0);
      expect(["kg", "cm", "%", "kcal"]).toContain(m.unit);
    }
    expect(MEASUREMENTS.find((m) => m.key === "body_weight")!.unit).toBe("kg");
  });

  it("formats today as a local YYYY-MM-DD date", () => {
    const d = new Date();
    expect(todayISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(todayISO()).toBe(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
    );
  });
});

describe("saving measurements", () => {
  it("stores one entry per type per day, replacing the value on a second log", async () => {
    const first = await saveMeasurement("body_weight", 80, "2026-03-01");
    const second = await saveMeasurement("body_weight", 79.5, "2026-03-01");
    expect(second.id).toBe(first.id);
    const rows = await db.measurements.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "body_weight", value: 79.5, date: "2026-03-01" });
  });

  it("keeps separate entries for different days and different types", async () => {
    await saveMeasurement("body_weight", 80, "2026-03-01");
    await saveMeasurement("body_weight", 79, "2026-03-02");
    await saveMeasurement("waist", 84, "2026-03-01");
    expect(await db.measurements.count()).toBe(3);
  });

  it("defaults the date to today", async () => {
    const row = await saveMeasurement("chest", 100);
    expect(row.date).toBe(todayISO());
  });

  it("queues upserts in the outbox that reuse the same row id", async () => {
    const a = await saveMeasurement("body_fat", 18, "2026-03-01");
    await saveMeasurement("body_fat", 17.5, "2026-03-01");
    const outbox = await db.outbox.orderBy("seq").toArray();
    expect(outbox).toHaveLength(2);
    expect(outbox.every((o) => o.table === "measurements" && o.op === "upsert")).toBe(true);
    expect(outbox.map((o) => o.row.id)).toEqual([a.id, a.id]);
    expect(outbox[1].row).toMatchObject({ value: 17.5 });
  });

  it("deletes locally and queues a delete", async () => {
    const row = await saveMeasurement("neck", 38, "2026-03-01");
    await deleteMeasurement(row.id);
    expect(await db.measurements.count()).toBe(0);
    expect(await db.outbox.orderBy("seq").last()).toMatchObject({
      table: "measurements",
      op: "delete",
      row: { id: row.id },
    });
  });
});

describe("reading measurements", () => {
  it("returns a series oldest first, filtered by type", async () => {
    await saveMeasurement("body_weight", 78, "2026-03-10");
    await saveMeasurement("body_weight", 80, "2026-03-01");
    await saveMeasurement("body_weight", 79, "2026-03-05");
    await saveMeasurement("waist", 84, "2026-03-03");
    const series = await measurementSeries("body_weight");
    expect(series.map((r) => r.date)).toEqual(["2026-03-01", "2026-03-05", "2026-03-10"]);
    expect(series.map((r) => r.value)).toEqual([80, 79, 78]);
  });

  it("gives the latest entry by date, or undefined when there is none", async () => {
    expect(await latestMeasurement("body_weight")).toBeUndefined();
    await saveMeasurement("body_weight", 78, "2026-03-10");
    await saveMeasurement("body_weight", 80, "2026-03-01");
    expect((await latestMeasurement("body_weight"))!.value).toBe(78);
  });
});

describe("BMI", () => {
  it("computes kg / m^2 rounded to one decimal", () => {
    expect(bmi(80, 180)).toBe(24.7);
    expect(bmi(70, 175)).toBe(22.9);
  });

  it("returns 0 when height is missing", () => {
    expect(bmi(80, 0)).toBe(0);
  });

  it("labels the standard bands at their boundaries", () => {
    expect(bmiLabel(18.4)).toBe("Underweight");
    expect(bmiLabel(18.5)).toBe("Healthy");
    expect(bmiLabel(24.9)).toBe("Healthy");
    expect(bmiLabel(25)).toBe("Overweight");
    expect(bmiLabel(29.9)).toBe("Overweight");
    expect(bmiLabel(30)).toBe("Obese");
  });
});
