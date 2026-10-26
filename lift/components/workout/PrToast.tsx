"use client";

import { useEffect } from "react";

const BITS = Array.from({ length: 28 }, (_, i) => i);
const COLORS = ["#facc15", "#4ade80", "#60a5fa", "#f472b6"];

export function PrToast({ title, detail, onDone }: { title: string; detail: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 3200);
    return () => clearTimeout(t);
  }, [onDone]);

  return (
    <div className="fixed inset-0 z-[60] pointer-events-none flex items-start justify-center pt-24">
      <style>{`@keyframes lift-fall{from{transform:translateY(-20px) rotate(0)}to{transform:translateY(420px) rotate(540deg);opacity:0}}`}</style>
      {BITS.map((i) => (
        <span
          key={i}
          className="absolute top-20 size-2 rounded-sm"
          style={{
            left: `${(i * 37) % 100}%`,
            background: COLORS[i % COLORS.length],
            animation: `lift-fall ${1.6 + (i % 5) * 0.3}s ease-in ${(i % 7) * 0.08}s forwards`,
          }}
        />
      ))}
      <div className="card border-accent px-5 py-4 text-center shadow-2xl pointer-events-auto" onClick={onDone}>
        <p className="text-3xl">🎉</p>
        <p className="font-bold text-accent">New PR!</p>
        <p className="font-semibold">{title}</p>
        <p className="text-xs text-muted">{detail}</p>
      </div>
    </div>
  );
}
