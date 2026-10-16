"use client";

import { db, uuid, type MeasurementRow } from "./offline/db";
import { enqueue } from "./offline/sync";

export const MEASUREMENTS = [
  { key: "body_weight", label: "Body weight", unit: "kg" },
  { key: "body_fat", label: "Body fat", unit: "%" },
  { key: "calories", label: "Caloric intake", unit: "kcal" },
  { key: "neck", label: "Neck", unit: "cm" },
  { key: "shoulders", label: "Shoulders", unit: "cm" },
  { key: "chest", label: "Chest", unit: "cm" },
  { key: "left_bicep", label: "Left bicep", unit: "cm" },
  { key: "right_bicep", label: "Right bicep", unit: "cm" },
  { key: "left_forearm", label: "Left forearm", unit: "cm" },
  { key: "right_forearm", label: "Right forearm", unit: "cm" },
  { key: "waist", label: "Waist", unit: "cm" },
  { key: "hips", label: "Hips", unit: "cm" },
  { key: "left_thigh", label: "Left thigh", unit: "cm" },
  { key: "right_thigh", label: "Right thigh", unit: "cm" },
  { key: "left_calf", label: "Left calf", unit: "cm" },
  { key: "right_calf", label: "Right calf", unit: "cm" },
  { key: "height", label: "Height", unit: "cm" },
  { key: "fat_free_mass", label: "Fat-free mass", unit: "kg" },
] as const;

export type MeasurementKey = (typeof MEASUREMENTS)[number]["key"];

export const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** One entry per type per day: logging again on the same day replaces the value. */
export async function saveMeasurement(type: MeasurementKey, value: number, date = todayISO()) {
  const existing = await db.measurements.where("[type+date]").equals([type, date]).first();
  const row: MeasurementRow = { id: existing?.id ?? uuid(), type, value, date };
  await db.measurements.put(row);
  await enqueue([{ table: "measurements", op: "upsert", row }]);
  return row;
}

export async function deleteMeasurement(id: string) {
  await db.measurements.delete(id);
  await enqueue([{ table: "measurements", op: "delete", row: { id } }]);
}

/** Entries for one measurement, oldest first. */
export async function measurementSeries(type: string): Promise<MeasurementRow[]> {
  return (await db.measurements.where("type").equals(type).toArray()).sort((a, b) => a.date.localeCompare(b.date));
}

export async function latestMeasurement(type: string): Promise<MeasurementRow | undefined> {
  return (await measurementSeries(type)).at(-1);
}

export const bmi = (kg: number, cm: number) => (cm > 0 ? Math.round((kg / (cm / 100) ** 2) * 10) / 10 : 0);

export function bmiLabel(b: number) {
  return b < 18.5 ? "Underweight" : b < 25 ? "Healthy" : b < 30 ? "Overweight" : "Obese";
}
