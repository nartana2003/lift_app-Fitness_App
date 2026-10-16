"use client";

import { useEffect, useRef, useState } from "react";
import { dispNum, fromDisplay, type Unit } from "@/lib/units";

/**
 * Weight field that shows/accepts the user's unit while the value is stored in kg.
 * Keeps its own text while focused so typing "62." or "62.5" isn't rewritten mid-keystroke.
 */
export function WeightInput({
  kg,
  unit,
  onChangeKg,
  placeholderKg,
  className = "",
}: {
  kg: number | "";
  unit: Unit;
  onChangeKg: (kg: number | "") => void;
  placeholderKg?: number;
  className?: string;
}) {
  const shown = kg === "" ? "" : String(dispNum(kg, unit));
  const [text, setText] = useState(shown);
  const focused = useRef(false);

  // Follow outside changes (suggestion applied, unit switched) but never while typing.
  useEffect(() => {
    if (!focused.current) setText(shown);
  }, [shown]);

  return (
    <input
      className={className}
      inputMode="decimal"
      value={text}
      placeholder={placeholderKg != null ? String(dispNum(placeholderKg, unit)) : "0"}
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false;
        setText(shown);
      }}
      onChange={(e) => {
        const raw = e.target.value.replace(",", ".");
        if (!/^\d*\.?\d*$/.test(raw)) return;
        setText(raw);
        const n = parseFloat(raw);
        onChangeKg(raw === "" || Number.isNaN(n) ? "" : fromDisplay(n, unit));
      }}
    />
  );
}
