// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { Segmented } from "@/components/progress/Segmented";

type Key = "volume" | "workouts" | "duration";
const OPTIONS: { value: Key; label: string }[] = [
  { value: "volume", label: "Volume" },
  { value: "workouts", label: "Workouts" },
  { value: "duration", label: "Duration" },
];

const isActive = (name: string) => screen.getByRole("button", { name }).className.includes("bg-accent");

/** Controlled wrapper, the way VolumeChart and PeriodCard use it. */
function Harness({ onChange }: { onChange?: (v: Key) => void }) {
  const [value, setValue] = useState<Key>("volume");
  return (
    <>
      <Segmented
        options={OPTIONS}
        value={value}
        onChange={(v) => {
          setValue(v);
          onChange?.(v);
        }}
      />
      <p>Showing {value}</p>
    </>
  );
}

describe("Segmented", () => {
  it("renders one button per option, in order", () => {
    render(<Segmented options={OPTIONS} value="volume" onChange={() => {}} />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Volume", "Workouts", "Duration"]);
  });

  it("uses type=button so it never submits a surrounding form", () => {
    render(<Segmented options={OPTIONS} value="volume" onChange={() => {}} />);
    for (const b of screen.getAllByRole("button")) expect(b).toHaveAttribute("type", "button");
  });

  it("highlights only the selected option with the black accent", () => {
    render(<Segmented options={OPTIONS} value="workouts" onChange={() => {}} />);
    expect(isActive("Workouts")).toBe(true);
    expect(isActive("Volume")).toBe(false);
    expect(isActive("Duration")).toBe(false);
    expect(screen.getByRole("button", { name: "Volume" })).toHaveClass("text-muted");
  });

  it("reports the tapped option's value, not its label", () => {
    const onChange = vi.fn();
    render(<Segmented options={OPTIONS} value="volume" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Duration" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("duration");
  });

  it("still reports a tap on the already-selected option", () => {
    const onChange = vi.fn();
    render(<Segmented options={OPTIONS} value="volume" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Volume" }));
    expect(onChange).toHaveBeenCalledWith("volume");
  });

  it("moves the highlight when used as a controlled switch", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    expect(screen.getByText("Showing volume")).toBeInTheDocument();
    expect(isActive("Volume")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Workouts" }));
    expect(screen.getByText("Showing workouts")).toBeInTheDocument();
    expect(isActive("Workouts")).toBe(true);
    expect(isActive("Volume")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Duration" }));
    expect(isActive("Duration")).toBe(true);
    expect(onChange.mock.calls.map((c) => c[0])).toEqual(["workouts", "duration"]);
  });

  it("does not move the highlight on its own when the parent ignores the change", () => {
    render(<Segmented options={OPTIONS} value="volume" onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Duration" }));
    expect(isActive("Volume")).toBe(true);
    expect(isActive("Duration")).toBe(false);
  });
});
