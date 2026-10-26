"use client";

import { EQUIPMENT } from "@/lib/muscles";
import { toggleEquipment, useEquipment } from "@/lib/equipment";

/** "My gym equipment" checklist for Profile. Saves on tap. */
export function EquipmentChecklist() {
  const have = useEquipment();
  return (
    <div>
      <p className="text-xs text-muted mb-2">Tick what your gym has. Suggestions and generated plans only use these.</p>
      <div className="flex flex-wrap gap-2" role="group" aria-label="My gym equipment">
        {EQUIPMENT.map((e) => {
          const on = have.includes(e);
          const last = on && have.length === 1;
          return (
            <button
              key={e}
              type="button"
              role="checkbox"
              aria-checked={on}
              aria-disabled={last || undefined}
              title={last ? "Keep at least one" : undefined}
              className={on ? "chip-on" : "chip"}
              onClick={() => void toggleEquipment(e)}
            >
              {e}
            </button>
          );
        })}
      </div>
      {have.length === 1 && <p className="text-xs text-muted mt-2">Keep at least one ticked.</p>}
    </div>
  );
}
