// Weights are always stored in kg. These helpers convert for display and input.

export type Unit = "kg" | "lb";

const LB_PER_KG = 2.2046226218;

export const toDisplay = (kg: number, unit: Unit): number => (unit === "lb" ? kg * LB_PER_KG : kg);
export const fromDisplay = (v: number, unit: Unit): number => (unit === "lb" ? v / LB_PER_KG : v);

export const round1 = (n: number) => Math.round(n * 10) / 10;

/** "62.5kg" / "137.8lb" */
export const fmtWeight = (kg: number, unit: Unit) => `${round1(toDisplay(kg, unit))}${unit}`;

/** Number only, rounded to 1 decimal, in the display unit. */
export const dispNum = (kg: number, unit: Unit) => round1(toDisplay(kg, unit));

/** "1,234kg" for big totals such as volume. */
export const fmtVolume = (kg: number, unit: Unit) => `${Math.round(toDisplay(kg, unit)).toLocaleString()}${unit}`;
