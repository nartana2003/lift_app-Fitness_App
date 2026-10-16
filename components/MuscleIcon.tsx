"use client";

import Model from "react-body-highlighter";
import { bodyMapData, GROUP_MAP, INTENSITY_COLORS } from "@/lib/bodyMap";
import type { MuscleGroup } from "@/lib/muscles";

const BODY = "#d1d5db";

/** Small body figure with one muscle group highlighted (front or back, whichever shows it). */
export function MuscleIcon({ muscle, className = "h-12" }: { muscle: MuscleGroup; className?: string }) {
  const { view } = GROUP_MAP[muscle];
  return (
    <span className={`block ${className}`} style={{ aspectRatio: "1 / 2" }} aria-hidden>
      <Model
        type={view}
        bodyColor={BODY}
        highlightedColors={[INTENSITY_COLORS[3]]}
        data={bodyMapData({ [muscle]: 1 }, view)}
        style={{ width: "100%", height: "100%" }}
      />
    </span>
  );
}

/** Front + back body maps, shaded by how many sets each muscle group got. */
export function BodyMap({ setsByGroup, className = "h-56" }: { setsByGroup: Record<string, number>; className?: string }) {
  return (
    <div className="flex items-start justify-center gap-4">
      {(["anterior", "posterior"] as const).map((view) => (
        <div key={view} className="text-center">
          <span className={`block ${className}`} style={{ aspectRatio: "1 / 2" }}>
            <Model
              type={view}
              bodyColor={BODY}
              highlightedColors={INTENSITY_COLORS}
              data={bodyMapData(setsByGroup, view)}
              style={{ width: "100%", height: "100%" }}
            />
          </span>
          <p className="text-[11px] text-muted mt-1">{view === "anterior" ? "Front" : "Back"}</p>
        </div>
      ))}
    </div>
  );
}
