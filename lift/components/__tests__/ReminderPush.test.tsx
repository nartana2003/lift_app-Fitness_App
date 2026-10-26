// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { db } from "@/lib/offline/db";

// The push flow itself is mocked (lib/push/client.test.ts covers it).
const push = vi.hoisted(() => ({
  available: true,
  state: "off" as "off" | "on" | "unavailable" | "denied",
  enableResult: "on" as "on" | "denied" | "signin" | "error" | "unavailable",
  enable: [] as unknown[],
  disabled: 0,
  synced: [] as unknown[],
}));
vi.mock("@/lib/push/client", () => ({
  pushAvailable: () => push.available,
  currentPushState: async () => push.state,
  enablePush: async (r: unknown) => {
    push.enable.push(r);
    return push.enableResult;
  },
  disablePush: async () => {
    push.disabled++;
    return true;
  },
  syncReminderSettings: async (r: unknown) => {
    push.synced.push(r);
    return true;
  },
}));

const { PUSH_MESSAGES, PUSH_OFF, PUSH_UNAVAILABLE, ReminderSettings } = await import("@/components/ReminderSettings");

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  localStorage.clear();
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: vi.fn() })) as unknown as typeof window.matchMedia;
  Object.assign(push, { available: true, state: "off", enableResult: "on", enable: [], disabled: 0, synced: [] });
});

describe("ReminderSettings push toggle", () => {
  it("enables, then turns off", async () => {
    render(<ReminderSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Enable notifications" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(PUSH_MESSAGES.on));
    expect(push.enable).toHaveLength(1);
    const off = await screen.findByRole("button", { name: "Turn off notifications" });
    fireEvent.click(off);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(PUSH_OFF));
    expect(push.disabled).toBe(1);
    expect(screen.getByRole("button", { name: "Enable notifications" })).toBeInTheDocument();
  });

  it.each(["denied", "signin", "error"] as const)("explains %s", async (res) => {
    push.enableResult = res;
    render(<ReminderSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Enable notifications" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(PUSH_MESSAGES[res]));
    expect(screen.getByRole("button", { name: "Enable notifications" })).toBeInTheDocument();
  });

  it("unavailable keeps the existing message and never calls enable", async () => {
    push.available = false;
    render(<ReminderSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Enable notifications" }));
    expect(screen.getByRole("status")).toHaveTextContent(PUSH_UNAVAILABLE);
    expect(push.enable).toEqual([]);
  });

  it("an already subscribed phone shows Turn off and keeps the server schedule in step", async () => {
    push.state = "on";
    render(<ReminderSettings />);
    await screen.findByRole("button", { name: "Turn off notifications" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Wed" }));
    await waitFor(() => expect(push.synced.some((r) => (r as { days: number[] }).days.includes(3))).toBe(true), { timeout: 3000 });
  });
});
