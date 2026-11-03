// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { db } from "@/lib/offline/db";

let path = "/";
vi.mock("next/navigation", () => ({
  usePathname: () => path,
}));

import { TabBar } from "@/components/TabBar";

const labels = () => screen.getAllByRole("link").map((a) => a.textContent);

beforeEach(async () => {
  path = "/";
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe("TabBar", () => {
  it("shows Home, Exercises, Coach, Progress, Profile in that order", () => {
    render(<TabBar />);
    expect(labels()).toEqual(["Home", "Exercises", "Coach", "Progress", "Profile"]);
    expect(screen.getByRole("link", { name: "Coach" })).toHaveAttribute("href", "/coach");
  });

  it("marks Coach active on /coach and only Coach", () => {
    path = "/coach";
    render(<TabBar />);
    expect(screen.getByRole("link", { name: "Coach" })).toHaveClass("font-semibold");
    expect(screen.getByRole("link", { name: "Home" })).not.toHaveClass("font-semibold");
    expect(screen.getByRole("link", { name: "Profile" })).not.toHaveClass("font-semibold");
  });

  it("keeps Home active on /history and Profile active on /profile", () => {
    path = "/history/abc";
    const { unmount } = render(<TabBar />);
    expect(screen.getByRole("link", { name: "Home" })).toHaveClass("font-semibold");
    unmount();
    path = "/profile";
    render(<TabBar />);
    expect(screen.getByRole("link", { name: "Profile" })).toHaveClass("font-semibold");
    expect(screen.getByRole("link", { name: "Coach" })).not.toHaveClass("font-semibold");
  });

  it("shows no Resume item while a workout is running (Home has the Resume button)", async () => {
    await db.active.put({ key: "active", id: "w1", started_at: new Date().toISOString(), routine_id: null, name: null, exercises: [] });
    render(<TabBar />);
    await new Promise((r) => setTimeout(r, 50));
    expect(labels()).toEqual(["Home", "Exercises", "Coach", "Progress", "Profile"]);
  });

  it("gives every item an equal share", () => {
    render(<TabBar />);
    for (const li of screen.getAllByRole("listitem")) expect(li).toHaveClass("flex-1", "min-w-0");
  });
});
