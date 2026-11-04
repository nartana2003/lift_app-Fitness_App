// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { QuickLog } from "@/components/workout/QuickLog";
import { MSG_MIC_BLOCKED } from "@/lib/speech";

const instances: FakeRecognition[] = [];
const current = () => instances[instances.length - 1];

class FakeRecognition {
  lang = "";
  continuous = false;
  interimResults = false;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = false;
  constructor() {
    instances.push(this);
  }
  start() {
    this.started = true;
  }
  stop() {
    this.started = false;
    this.onend?.();
  }
}

const say = (text: string) =>
  act(() => current().onresult!({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: text } }] }));

const renderQuickLog = () => {
  render(<QuickLog unit="kg" nameOf={() => undefined} onLog={async () => true} />);
  fireEvent.click(screen.getByRole("button", { name: "Quick log" }));
};

afterEach(() => {
  instances.length = 0;
  vi.unstubAllGlobals();
});

describe("QuickLog voice", () => {
  it("shows no mic button where the browser has no speech recognition", () => {
    renderQuickLog();
    expect(screen.queryByRole("button", { name: /Speak|Listening/ })).toBeNull();
    expect(screen.getByText(/Type what you did/)).toBeInTheDocument();
  });

  it("fills the text box with what is said, appended to what is typed", async () => {
    vi.stubGlobal("SpeechRecognition", FakeRecognition);
    renderQuickLog();
    const box = screen.getByLabelText("Quick log text");
    fireEvent.change(box, { target: { value: "bench 3x8" } });
    fireEvent.click(await screen.findByRole("button", { name: "Speak" }));
    expect(current().started).toBe(true);
    expect(current().continuous).toBe(true);
    expect(screen.getByRole("button", { name: /Listening/ })).toHaveAttribute("aria-pressed", "true");
    say("at 60");
    expect(box).toHaveValue("bench 3x8 at 60");
    say("then curls 3x12 at 12");
    expect(box).toHaveValue("bench 3x8 at 60 then curls 3x12 at 12");
    // The text is real text: Preview works and the user can still edit it.
    expect(screen.getByRole("button", { name: "Preview" })).toBeEnabled();
  });

  it("tapping again stops listening", async () => {
    vi.stubGlobal("SpeechRecognition", FakeRecognition);
    renderQuickLog();
    fireEvent.click(await screen.findByRole("button", { name: "Speak" }));
    fireEvent.click(screen.getByRole("button", { name: /Listening/ }));
    expect(current().started).toBe(false);
    expect(await screen.findByRole("button", { name: "Speak" })).toHaveAttribute("aria-pressed", "false");
  });

  it("works with the webkit-prefixed constructor", async () => {
    vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
    renderQuickLog();
    expect(await screen.findByRole("button", { name: "Speak" })).toBeInTheDocument();
  });

  it("tells the user when the microphone is blocked, and typing still works", async () => {
    vi.stubGlobal("SpeechRecognition", FakeRecognition);
    renderQuickLog();
    fireEvent.click(await screen.findByRole("button", { name: "Speak" }));
    act(() => current().onerror!({ error: "not-allowed" }));
    expect(screen.getByText(MSG_MIC_BLOCKED)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Quick log text"), { target: { value: "bench 3x8" } });
    expect(screen.getByRole("button", { name: "Preview" })).toBeEnabled();
  });

  it("stops listening when the form is closed", async () => {
    vi.stubGlobal("SpeechRecognition", FakeRecognition);
    renderQuickLog();
    fireEvent.click(await screen.findByRole("button", { name: "Speak" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(current().started).toBe(false);
  });
});
