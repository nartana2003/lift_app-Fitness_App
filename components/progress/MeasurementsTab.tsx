"use client";

import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { db } from "@/lib/offline/db";
import {
  bmi,
  bmiLabel,
  deleteMeasurement,
  MEASUREMENTS,
  saveMeasurement,
  todayISO,
  type MeasurementKey,
} from "@/lib/measurements";
import { useSettings } from "@/lib/settings";
import { dispNum, fromDisplay, type Unit } from "@/lib/units";

type Def = (typeof MEASUREMENTS)[number];

/** kg-based measurements follow the user's weight unit; others keep their own. */
const unitOf = (m: Def, unit: Unit) => (m.unit === "kg" ? unit : m.unit);
const toShown = (m: Def, v: number, unit: Unit) => (m.unit === "kg" ? dispNum(v, unit) : v);

export function MeasurementsTab() {
  const { unit } = useSettings();
  const rows = useLiveQuery(() => db.measurements.toArray(), []);
  const [open, setOpen] = useState<MeasurementKey | null>(null);

  const latest = useMemo(() => {
    const m = new Map<string, { value: number; prev?: number }>();
    const sorted = [...(rows ?? [])].sort((a, b) => a.date.localeCompare(b.date));
    for (const r of sorted) m.set(r.type, { value: r.value, prev: m.get(r.type)?.value });
    return m;
  }, [rows]);

  if (!rows) return null;

  return (
    <>
      <ul className="space-y-2">
        {MEASUREMENTS.map((m) => {
          const l = latest.get(m.key);
          const diff = l?.prev !== undefined ? toShown(m, l.value, unit) - toShown(m, l.prev, unit) : null;
          return (
            <li key={m.key}>
              <button className="card w-full flex items-center gap-3 p-3 text-left" onClick={() => setOpen(m.key)}>
                <span className="size-12 rounded-xl bg-surface-2 grid place-items-center text-xs font-bold text-muted shrink-0">
                  {unitOf(m, unit)}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block font-semibold">{m.label}</span>
                  <span className="block text-xs text-muted">
                    {l ? (
                      <>
                        <span className="font-semibold text-text">{toShown(m, l.value, unit)} {unitOf(m, unit)}</span>
                        {diff !== null && diff !== 0 && <> · {diff > 0 ? "▲" : "▼"} {Math.abs(Math.round(diff * 10) / 10)}</>}
                      </>
                    ) : (
                      "No measurements yet"
                    )}
                  </span>
                </span>
                <span className="chip text-xs font-semibold">{l ? "Add" : "Start Tracking"}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {open && <MeasurementModal def={MEASUREMENTS.find((m) => m.key === open)!} onClose={() => setOpen(null)} />}
    </>
  );
}

function MeasurementModal({ def, onClose }: { def: Def; onClose: () => void }) {
  const { unit } = useSettings();
  const series = useLiveQuery(
    async () => (await db.measurements.where("type").equals(def.key).toArray()).sort((a, b) => a.date.localeCompare(b.date)),
    [def.key],
  );
  const heightRow = useLiveQuery(async () => (await db.measurements.where("type").equals("height").toArray()).sort((a, b) => a.date.localeCompare(b.date)).at(-1), []);
  const [value, setValue] = useState("");
  const [date, setDate] = useState(todayISO());

  const data = (series ?? []).map((r) => ({
    label: new Date(r.date + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short" }),
    value: toShown(def, r.value, unit),
  }));
  const lastKg = series?.at(-1)?.value;
  const bmiVal = def.key === "body_weight" && lastKg && heightRow ? bmi(lastKg, heightRow.value) : 0;

  async function add() {
    const n = parseFloat(value.replace(",", "."));
    if (!Number.isFinite(n) || n <= 0) return;
    await saveMeasurement(def.key, def.unit === "kg" ? Math.round(fromDisplay(n, unit) * 100) / 100 : n, date);
    setValue("");
  }

  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div className="card w-full max-w-lg max-h-[92dvh] overflow-y-auto rounded-b-none sm:rounded-b-2xl p-4 pb-safe" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 mb-3">
          <h2 className="flex-1 text-lg font-bold">{def.label}</h2>
          <button className="size-9 rounded-full bg-surface-2 text-lg" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="flex gap-2 mb-4">
          <input
            className="field flex-1"
            inputMode="decimal"
            placeholder={`Value (${unitOf(def, unit)})`}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
          <input className="field w-40" type="date" max={todayISO()} value={date} onChange={(e) => setDate(e.target.value)} />
          <button className="btn-primary px-4" onClick={add}>Add</button>
        </div>

        {bmiVal > 0 && (
          <p className="text-sm mb-3">
            BMI <span className="font-semibold">{bmiVal}</span> <span className="text-muted">· {bmiLabel(bmiVal)}</span>
          </p>
        )}

        {data.length > 1 ? (
          <div className="h-52 mb-3">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="#e5e7eb" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#6b7280" }} tickLine={false} axisLine={{ stroke: "#e5e7eb" }} minTickGap={24} />
                <YAxis width={40} tick={{ fontSize: 10, fill: "#6b7280" }} tickLine={false} axisLine={false} domain={["auto", "auto"]} />
                <Tooltip formatter={(v) => [`${v} ${unitOf(def, unit)}`, def.label]} contentStyle={{ borderRadius: 12, border: "1px solid #e5e7eb", fontSize: 12 }} />
                <Line type="monotone" dataKey="value" stroke="#111111" strokeWidth={2} dot={{ r: 3, fill: "#111111" }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className="text-sm text-muted text-center py-6">Add at least two entries to see a chart.</p>
        )}

        {series && series.length > 0 && (
          <ul className="divide-y divide-border">
            {[...series].reverse().map((r) => (
              <li key={r.id} className="flex items-center justify-between py-2 text-sm">
                <span className="text-muted">{new Date(r.date + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}</span>
                <span className="font-semibold">{toShown(def, r.value, unit)} {unitOf(def, unit)}</span>
                <button className="text-muted text-xs" onClick={() => confirm("Delete this entry?") && deleteMeasurement(r.id)}>Delete</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
