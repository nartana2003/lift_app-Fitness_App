// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { db } from "@/lib/offline/db";
import { THEME_STORAGE_KEY } from "@/lib/theme";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), back: vi.fn() }),
  usePathname: () => "/profile",
  useSearchParams: () => new URLSearchParams(),
}));

import ProfilePage from "@/app/(tabs)/profile/page";

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: vi.fn() })) as unknown as typeof window.matchMedia;
});

async function openPreferences() {
  render(<ProfilePage />);
  fireEvent.click(screen.getByRole("button", { name: /Preferences/ }));
  return screen.getByRole("radiogroup", { name: "Theme" });
}

describe("Profile theme toggle", () => {
  it("offers Light, Dark and System with Light selected by default", async () => {
    await openPreferences();
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual(["Light", "Dark", "System"]);
    expect(screen.getByRole("radio", { name: "Light" })).toHaveAttribute("aria-checked", "true");
  });

  it("choosing Dark applies it, persists it and marks it selected", async () => {
    await openPreferences();
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    await waitFor(async () => expect((await db.meta.get("settings"))?.value).toMatchObject({ theme: "dark" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true"));
    expect(screen.getByRole("radio", { name: "Light" })).toHaveAttribute("aria-checked", "false");
  });

  it("choosing System resolves from the OS preference", async () => {
    window.matchMedia = vi.fn(() => ({ matches: true, addEventListener: vi.fn() })) as unknown as typeof window.matchMedia;
    await openPreferences();
    fireEvent.click(screen.getByRole("radio", { name: "System" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    await waitFor(() => expect(screen.getByRole("radio", { name: "System" })).toHaveAttribute("aria-checked", "true"));
  });
});
