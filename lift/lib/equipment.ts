"use client";

/**
 * "My gym equipment": which EQUIPMENT buckets the user has access to. Saved on
 * this device in Dexie meta (so it is included in backups) and read by the AI
 * call sites through getEquipment() / equipmentForAi().
 *
 * Unset means "full gym": every bucket is available. The list can never be
 * emptied from the UI (the last ticked item cannot be unticked).
 */

import { useLiveQuery } from "dexie-react-hooks";
import { db } from "./offline/db";
import { EQUIPMENT, type Equipment } from "./muscles";

export const EQUIPMENT_KEY = "equipment";

const isEquipment = (v: unknown): v is Equipment => typeof v === "string" && (EQUIPMENT as readonly string[]).includes(v);

/**
 * Pure: turns whatever is stored into a clean list in catalogue order.
 * Unknown values and duplicates are dropped. Missing, malformed or empty
 * input falls back to every bucket.
 */
export function normalizeEquipment(raw: unknown): Equipment[] {
  if (!Array.isArray(raw)) return [...EQUIPMENT];
  const have = new Set(raw.filter(isEquipment));
  if (have.size === 0) return [...EQUIPMENT];
  return EQUIPMENT.filter((e) => have.has(e));
}

/** Pure: ticks or unticks one bucket. Unticking the last one is refused. */
export function toggleEquipmentIn(list: readonly Equipment[], e: Equipment): Equipment[] {
  const cur = normalizeEquipment(list);
  if (cur.includes(e)) {
    if (cur.length === 1) return cur;
    return cur.filter((x) => x !== e);
  }
  return normalizeEquipment([...cur, e]);
}

/**
 * Pure: the equipment list to send to an AI route. The routes read an empty
 * list as "no restriction", so a full gym is sent as [].
 */
export function equipmentForAi(list: readonly Equipment[]): Equipment[] {
  const cur = normalizeEquipment(list);
  return cur.length === EQUIPMENT.length ? [] : cur;
}

/** Pure: buckets the user does not have, in catalogue order. */
export function missingEquipment(list: readonly Equipment[]): Equipment[] {
  const cur = normalizeEquipment(list);
  return EQUIPMENT.filter((e) => !cur.includes(e));
}

/** Short summary for the Profile row, e.g. "Full gym" or "Dumbbell, Bodyweight". */
export function equipmentSummary(list: readonly Equipment[]): string {
  const cur = normalizeEquipment(list);
  return cur.length === EQUIPMENT.length ? "Full gym" : cur.join(", ");
}

/** Saved equipment (every bucket until the user changes it). */
export async function getEquipment(): Promise<Equipment[]> {
  return normalizeEquipment((await db.meta.get(EQUIPMENT_KEY))?.value);
}

export async function saveEquipment(list: readonly Equipment[]): Promise<Equipment[]> {
  const clean = normalizeEquipment(list);
  await db.meta.put({ key: EQUIPMENT_KEY, value: clean });
  return clean;
}

/** Ticks or unticks one bucket and saves the result. */
export async function toggleEquipment(e: Equipment): Promise<Equipment[]> {
  return db.transaction("rw", db.meta, async () => {
    const next = toggleEquipmentIn(await getEquipment(), e);
    await db.meta.put({ key: EQUIPMENT_KEY, value: next });
    return next;
  });
}

/** Live saved equipment for components. */
export function useEquipment(): Equipment[] {
  return useLiveQuery(getEquipment, [], [...EQUIPMENT]);
}
