// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { db } from "@/lib/offline/db";
import { EQUIPMENT } from "@/lib/muscles";
import { EQUIPMENT_KEY, saveEquipment } from "@/lib/equipment";
import { EquipmentChecklist } from "@/components/EquipmentChecklist";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), back: vi.fn() }),
  usePathname: () => "/profile",
  useSearchParams: () => new URLSearchParams(),
}));

import ProfilePage from "@/app/(tabs)/profile/page";

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  localStorage.clear();
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: vi.fn() })) as unknown as typeof window.matchMedia;
});

const stored = async () => (await db.meta.get(EQUIPMENT_KEY))?.value;

describe("EquipmentChecklist", () => {
  it("lists every equipment bucket, all ticked by default", () => {
    render(<EquipmentChecklist />);
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes.map((b) => b.textContent)).toEqual([...EQUIPMENT]);
    for (const b of boxes) expect(b).toHaveAttribute("aria-checked", "true");
  });

  it("unticking saves on the device and updates the checkbox", async () => {
    render(<EquipmentChecklist />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Barbell" }));
    await waitFor(async () => expect(await stored()).toEqual(EQUIPMENT.filter((e) => e !== "Barbell")));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Barbell" })).toHaveAttribute("aria-checked", "false"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Barbell" }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Barbell" })).toHaveAttribute("aria-checked", "true"));
  });

  it("shows the saved list and keeps the last one ticked", async () => {
    await saveEquipment(["Bodyweight"]);
    render(<EquipmentChecklist />);
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Dumbbell" })).toHaveAttribute("aria-checked", "false"));
    const bw = screen.getByRole("checkbox", { name: "Bodyweight" });
    expect(bw).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Keep at least one ticked.")).toBeInTheDocument();
    fireEvent.click(bw);
    await waitFor(async () => expect(await stored()).toEqual(["Bodyweight"]));
    expect(bw).toHaveAttribute("aria-checked", "true");
  });
});

describe("Profile equipment section", () => {
  it("is collapsed by default, summarises and opens to the checklist", async () => {
    await saveEquipment(["Dumbbell", "Bodyweight"]);
    render(<ProfilePage />);
    const header = screen.getByRole("button", { name: /My gym equipment/ });
    expect(header).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(header).toHaveTextContent("Dumbbell, Bodyweight"));
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    fireEvent.click(header);
    expect(screen.getAllByRole("checkbox")).toHaveLength(EQUIPMENT.length);
  });

  it("keeps the existing Profile sections", () => {
    render(<ProfilePage />);
    for (const name of ["Personal information", "Body", "Goals", "My split", "Preferences", "Backup", "Import data", "Account"]) {
      expect(screen.getByRole("button", { name: new RegExp(`^${name}`) })).toBeInTheDocument();
    }
  });
});
