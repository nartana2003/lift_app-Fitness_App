/**
 * Server-only shared helpers for validating AI route bodies and building
 * prompts. Pure, no runtime dependencies beyond the muscle and equipment
 * lists.
 *
 * lib/ai/generate-routines.ts and lib/ai/goal-targets.ts still carry their own
 * private copies of isObj / onlyKeys / isInt / isNum / isMuscle / escapeForTag;
 * new AI modules import from here instead (switching the two older files over
 * is a follow-up, not done here).
 */
import { EQUIPMENT, MUSCLE_GROUPS, type Equipment, type MuscleGroup } from "../muscles";

/** A plain object (not null, not an array). */
export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** True when every key of `o` is in `allowed`. */
export const onlyKeys = (o: Record<string, unknown>, allowed: readonly string[]) => Object.keys(o).every((k) => allowed.includes(k));

/** An integer in lo..hi (inclusive). */
export const isInt = (v: unknown, lo: number, hi: number): v is number =>
  Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

/** A finite number in lo..hi (inclusive). */
export const isNum = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

/** One of MUSCLE_GROUPS, exact spelling. */
export const isMuscle = (v: unknown): v is MuscleGroup => typeof v === "string" && (MUSCLE_GROUPS as readonly string[]).includes(v);

/** One of EQUIPMENT, exact spelling. */
export const isEquipment = (v: unknown): v is Equipment => typeof v === "string" && (EQUIPMENT as readonly string[]).includes(v);

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date written as YYYY-MM-DD (2026-02-30 is rejected). */
export function isDateKey(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = DATE_RE.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/**
 * A list of unique allowed equipment, or null when the value is not an array
 * of known equipment names. Duplicates are removed, order is kept.
 */
export function equipmentList(v: unknown): Equipment[] | null {
  if (!Array.isArray(v) || v.length > EQUIPMENT.length * 2) return null;
  const out: Equipment[] = [];
  for (const e of v) {
    if (!isEquipment(e)) return null;
    if (!out.includes(e)) out.push(e);
  }
  return out;
}

/**
 * Escape characters that could close or open a tag inside the <user_data>
 * block. The JSON stays valid; the model reads \u003c as "<".
 */
export const escapeForTag = (json: string) => json.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");

/** JSON.parse that returns undefined instead of throwing. */
export function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
