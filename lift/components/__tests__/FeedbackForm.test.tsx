// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { FeedbackForm, FEEDBACK_MAX } from "@/components/FeedbackForm";
import { MAX_FEEDBACK_CHARS } from "@/lib/feedback/submit";

type Reply = { status: number; body?: unknown } | Error;

let getReply: Reply;
let postReplies: Reply[];
const posted: unknown[] = [];

function respond(r: Reply) {
  if (r instanceof Error) return Promise.reject(r);
  return Promise.resolve(Response.json(r.body ?? {}, { status: r.status }));
}

beforeEach(() => {
  getReply = { status: 200, body: { items: [] } };
  postReplies = [];
  posted.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posted.push(JSON.parse(init.body as string));
        return respond(postReplies.shift() ?? { status: 200, body: { ok: true, number: 1 } });
      }
      return respond(getReply);
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

const box = () => screen.getByLabelText("Feedback message") as HTMLTextAreaElement;
const sendBtn = () => screen.getByRole("button", { name: "Send" });

describe("FeedbackForm", () => {
  it("keeps the client cap in step with the server", () => {
    expect(FEEDBACK_MAX).toBe(MAX_FEEDBACK_CHARS);
  });

  it("counts characters and disables Send while blank", () => {
    render(<FeedbackForm />);
    expect(screen.getByText(`0 / ${FEEDBACK_MAX}`)).toBeInTheDocument();
    expect(sendBtn()).toBeDisabled();
    fireEvent.change(box(), { target: { value: "   " } });
    expect(sendBtn()).toBeDisabled();
    fireEvent.change(box(), { target: { value: "Great app" } });
    expect(screen.getByText(`9 / ${FEEDBACK_MAX}`)).toBeInTheDocument();
    expect(sendBtn()).toBeEnabled();
    expect(box().maxLength).toBe(FEEDBACK_MAX);
  });

  it("sends the trimmed message, clears the box and thanks the user", async () => {
    render(<FeedbackForm />);
    fireEvent.change(box(), { target: { value: "  Add a plate calculator  " } });
    fireEvent.click(sendBtn());
    expect(await screen.findByText("Thanks, your feedback was sent.")).toBeInTheDocument();
    expect(posted).toEqual([{ message: "Add a plate calculator" }]);
    expect(box().value).toBe("");
  });

  it.each([
    [{ status: 503 }, "Feedback is not set up yet."],
    [{ status: 429 }, "Too many messages, try again in a minute."],
    [{ status: 401 }, "Sign in to send feedback."],
    [{ status: 500 }, "Could not send. Check your connection and try again."],
    [new Error("offline"), "Could not send. Check your connection and try again."],
  ] as [Reply, string][])("shows an error and keeps the text (%#)", async (reply, text) => {
    postReplies = [reply];
    render(<FeedbackForm />);
    fireEvent.change(box(), { target: { value: "Keep me" } });
    fireEvent.click(sendBtn());
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(box().value).toBe("Keep me");
    expect(sendBtn()).toBeEnabled();
  });

  it("lists past feedback with its status", async () => {
    getReply = {
      status: 200,
      body: {
        items: [
          { number: 2, message: "Timer sound\nmore detail", created_at: "2026-11-02T10:00:00Z", status: "fixed" },
          { number: 1, message: "Dark mode", created_at: "2026-11-01T10:00:00Z", status: "open" },
          { number: 3, message: "Old idea", created_at: "2026-10-01T10:00:00Z", status: "unknown" },
        ],
      },
    };
    render(<FeedbackForm />);
    const list = await screen.findByRole("list", { name: "Your feedback" });
    expect(list.textContent).toContain("Timer sound");
    expect(list.textContent).not.toContain("more detail");
    expect(screen.getByText("Fixed").className).toContain("chip-on");
    expect(screen.getByText("Open").className).not.toContain("chip-on");
    expect(screen.getByText("Status unavailable")).toBeInTheDocument();
  });

  it("hides the list quietly when it cannot load, and the form still works", async () => {
    getReply = { status: 401 };
    render(<FeedbackForm />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole("list", { name: "Your feedback" })).toBeNull();
    fireEvent.change(box(), { target: { value: "hi" } });
    fireEvent.click(sendBtn());
    expect(await screen.findByText("Thanks, your feedback was sent.")).toBeInTheDocument();
  });

  it("reloads the list after a successful send", async () => {
    render(<FeedbackForm />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    getReply = { status: 200, body: { items: [{ number: 9, message: "New one", created_at: "2026-11-08T10:00:00Z", status: "open" }] } };
    fireEvent.change(box(), { target: { value: "New one" } });
    fireEvent.click(sendBtn());
    expect(await screen.findByRole("list", { name: "Your feedback" })).toBeInTheDocument();
  });
});
