// @vitest-environment jsdom
// NAV-01: My Routines moved from Home to the Exercises tab (Exercises | Routines switch).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const replace = vi.fn();
let search = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh: vi.fn(), push: vi.fn(), back: vi.fn() }),
  usePathname: () => "/exercises",
  useSearchParams: () => search,
}));

// Stubs for the heavy children: these tests are about which section shows where.
vi.mock("@/components/routines/RoutineList", () => ({ RoutineList: () => <section>My Routines stub</section> }));
vi.mock("@/components/ExerciseBrowser", () => ({ ExerciseBrowser: () => <div>Exercise browser stub</div> }));
vi.mock("@/components/planner/WeekStrip", () => ({ WeekStrip: () => <div>Week strip stub</div> }));
vi.mock("@/components/HistoryList", () => ({ HistoryList: () => <div>History stub</div> }));
vi.mock("@/lib/catalogue", () => ({ useCatalogue: () => ({ exercises: [], loading: false, get: () => undefined }) }));

import { LibrarySwitch, ROUTINES_HREF, parseLibraryView } from "@/components/routines/LibrarySwitch";
import ExercisesPage from "@/app/(tabs)/exercises/page";
import Home from "@/app/(tabs)/page";

beforeEach(() => {
  replace.mockReset();
  search = new URLSearchParams();
});

describe("parseLibraryView", () => {
  it("is routines only for view=routines", () => {
    expect(parseLibraryView("routines")).toBe("routines");
    expect(parseLibraryView("exercises")).toBe("exercises");
    expect(parseLibraryView(null)).toBe("exercises");
    expect(parseLibraryView(undefined)).toBe("exercises");
    expect(parseLibraryView("")).toBe("exercises");
    expect(parseLibraryView("Routines")).toBe("exercises");
  });

  it("the routines link round-trips to the routines view", () => {
    expect(parseLibraryView(new URL(ROUTINES_HREF, "http://x").searchParams.get("view"))).toBe("routines");
  });
});

describe("LibrarySwitch", () => {
  it("marks the current view and reports a change only for the other one", () => {
    const onChange = vi.fn();
    render(<LibrarySwitch view="exercises" onChange={onChange} />);
    const ex = screen.getByRole("radio", { name: "Exercises" });
    const rt = screen.getByRole("radio", { name: "Routines" });
    expect(ex).toHaveAttribute("aria-checked", "true");
    expect(rt).toHaveAttribute("aria-checked", "false");
    fireEvent.click(ex);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(rt);
    expect(onChange).toHaveBeenCalledWith("routines");
  });
});

describe("Exercises tab", () => {
  it("defaults to Exercises: browser and New exercise shown, no routines", () => {
    render(<ExercisesPage />);
    expect(screen.getByRole("radio", { name: "Exercises" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Exercise browser stub")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "New exercise" })).toBeInTheDocument();
    expect(screen.queryByText("My Routines stub")).not.toBeInTheDocument();
  });

  it("switching to Routines puts view=routines in the URL", () => {
    render(<ExercisesPage />);
    fireEvent.click(screen.getByRole("radio", { name: "Routines" }));
    expect(replace).toHaveBeenCalledWith("/exercises?view=routines", { scroll: false });
  });

  it("view=routines shows My Routines instead of the browser", () => {
    search = new URLSearchParams("view=routines");
    render(<ExercisesPage />);
    expect(screen.getByRole("radio", { name: "Routines" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("My Routines stub")).toBeInTheDocument();
    expect(screen.queryByText("Exercise browser stub")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "New exercise" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Exercises" }));
    expect(replace).toHaveBeenCalledWith("/exercises", { scroll: false });
  });
});

describe("Home", () => {
  it("no longer shows My Routines; the other sections are still there", async () => {
    render(<Home />);
    expect(await screen.findByRole("button", { name: "Start Workout" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Weekly Snapshot" })).toBeInTheDocument();
    expect(screen.getByText("Week strip stub")).toBeInTheDocument();
    expect(screen.getByText("History stub")).toBeInTheDocument();
    expect(screen.queryByText("My Routines stub")).not.toBeInTheDocument();
  });
});
