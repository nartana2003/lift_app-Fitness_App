// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { db } from "@/lib/offline/db";

// Push is mocked: no service worker, no server, nothing is sent.
const push = vi.hoisted(() => ({ available: true, state: "off" as "off" | "on" | "unavailable" | "denied" }));
vi.mock("@/lib/push/client", () => ({
  pushAvailable: () => push.available,
  currentPushState: async () => push.state,
  enablePush: async () => "on",
  disablePush: async () => true,
  syncReminderSettings: async () => true,
}));

const { REST_PUSH_NEEDS_NOTIFICATIONS, REST_PUSH_UNAVAILABLE, ReminderSettings } = await import("@/components/ReminderSettings");
const { RestTimer } = await import("@/components/RestTimer");
const { restTimer } = await import("@/lib/restTimer");
const { restPushEnabled, setRestPushEnabled } = await import("@/lib/restTimerPushClient");
const { REST_PUSH_LS, REST_TIMER_URL } = await import("@/lib/restTimerPush");

const EP = "https://fcm.googleapis.com/fcm/send/abc";
let visibility: DocumentVisibilityState = "visible";
const fetchCalls: { url: string; init: RequestInit }[] = [];

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  localStorage.clear();
  Object.assign(push, { available: true, state: "off" });
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: vi.fn() })) as unknown as typeof window.matchMedia;
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { ready: Promise.resolve({ pushManager: { getSubscription: async () => ({ endpoint: EP }) } }) },
  });
  fetchCalls.length = 0;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    fetchCalls.push({ url, init });
    return new Response("{}", { status: 200 });
  });
});

afterEach(() => {
  act(() => restTimer.stop());
  vi.unstubAllGlobals();
});

describe("Reminders > Rest timer alerts", () => {
  it("turns on per phone and asks for notifications when they are off", async () => {
    render(<ReminderSettings />);
    const sw = screen.getByRole("switch", { name: "Rest timer alerts" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    fireEvent.click(sw);
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "true"));
    expect(localStorage.getItem(REST_PUSH_LS)).toBe("1");
    expect(screen.getByText(REST_PUSH_NEEDS_NOTIFICATIONS)).toBeInTheDocument();
    fireEvent.click(sw);
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "false"));
    expect(restPushEnabled()).toBe(false);
  });

  it("stays off with a plain message when push is unavailable", async () => {
    push.available = false;
    render(<ReminderSettings />);
    const sw = screen.getByRole("switch", { name: "Rest timer alerts" });
    fireEvent.click(sw);
    expect(screen.getByText(REST_PUSH_UNAVAILABLE)).toBeInTheDocument();
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(restPushEnabled()).toBe(false);
  });
});

describe("RestTimer push hook", () => {
  const hide = (v: DocumentVisibilityState) =>
    act(() => {
      visibility = v;
      document.dispatchEvent(new Event("visibilitychange"));
    });

  it("schedules when the app hides with a timer running and cancels on return", async () => {
    setRestPushEnabled(true);
    render(<RestTimer />);
    act(() => restTimer.start(90, "Rest"));
    // The in-app timer is unchanged.
    expect(screen.getByText("Skip")).toBeInTheDocument();
    hide("hidden");
    await waitFor(() => expect(fetchCalls).toHaveLength(1));
    expect(fetchCalls[0].url).toBe(REST_TIMER_URL);
    expect(fetchCalls[0].init.method).toBe("POST");
    const body = JSON.parse(String(fetchCalls[0].init.body));
    expect(body.endpoint).toBe(EP);
    expect(body.delaySec).toBeGreaterThanOrEqual(89);
    expect(body.delaySec).toBeLessThanOrEqual(90);
    hide("visible");
    await waitFor(() => expect(fetchCalls).toHaveLength(2));
    expect(fetchCalls[1].init.method).toBe("DELETE");
  });

  it("sends nothing when not opted in or push is unavailable", async () => {
    render(<RestTimer />);
    act(() => restTimer.start(90, "Rest"));
    hide("hidden");
    setRestPushEnabled(true);
    push.available = false;
    hide("hidden");
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchCalls).toHaveLength(0);
    expect(screen.getByText("Skip")).toBeInTheDocument();
  });
});
