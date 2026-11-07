// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { db } from "@/lib/offline/db";
import { ExerciseBrowser } from "@/components/ExerciseBrowser";
import type { Exercise } from "@/lib/exercises";

// Issue #7: a Cardio tab in the Exercises browser.
const ex = (id: string, over: Partial<Exercise> = {}): Exercise => ({
  id,
  name: id,
  muscle_groups: ["Chest"],
  secondary_groups: [],
  equipment: "Barbell",
  category: "strength",
  mechanic: null,
  force: null,
  level: "beginner",
  instructions: [],
  image_urls: [],
  tiktok_url: "",
  ...over,
});

const LIST = [
  ex("Bench Press"),
  ex("Squat", { muscle_groups: ["Quads"] }),
  ex("Recumbent Bike", { muscle_groups: ["Quads"], equipment: "Machine/Cable", category: "cardio" }),
  ex("Rope Jumping", { muscle_groups: ["Quads"], equipment: "Other", category: "cardio" }),
];

function Harness() {
  const [muscle, setMuscle] = useState<string | undefined>();
  return <ExerciseBrowser exercises={LIST} muscle={muscle} onMuscle={setMuscle} />;
}

const names = () => screen.queryAllByRole("heading", { level: 3 }).map((h) => h.textContent);

beforeEach(async () => {
  cleanup();
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe("ExerciseBrowser Cardio tab", () => {
  it("shows a Cardio tab next to Favorites", () => {
    render(<Harness />);
    const tabs = screen.getAllByRole("button", { pressed: false }).map((b) => b.textContent);
    expect(tabs.indexOf("Cardio")).toBe(tabs.indexOf("Favorites") + 1);
  });

  it("lists only cardio exercises when selected, and all again when tapped twice", () => {
    render(<Harness />);
    expect(names()).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "Cardio" }));
    expect(names()).toEqual(["Recumbent Bike", "Rope Jumping"]);
    expect(screen.getByText(/2 exercises/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cardio" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Cardio" }));
    expect(names()).toHaveLength(4);
  });

  it("search narrows within cardio", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Cardio" }));
    fireEvent.change(screen.getByPlaceholderText("Search for exercises"), { target: { value: "rope" } });
    expect(names()).toEqual(["Rope Jumping"]);
  });

  it("muscle tabs still filter as before, and cardio exercises stay under their muscle", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Quads" }));
    expect(names()).toEqual(["Squat", "Recumbent Bike", "Rope Jumping"]);
    fireEvent.click(screen.getByRole("button", { name: "Chest" }));
    expect(names()).toEqual(["Bench Press"]);
  });

  it("switching from Cardio to Favorites clears the cardio filter", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Cardio" }));
    fireEvent.click(screen.getByRole("button", { name: "Favorites" }));
    expect(names()).toEqual([]);
    expect(screen.getByText(/Tap the bookmark/)).toBeInTheDocument();
  });
});
