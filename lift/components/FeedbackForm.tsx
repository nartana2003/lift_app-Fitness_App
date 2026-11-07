"use client";

import { useCallback, useEffect, useState } from "react";

// Mirrors MAX_FEEDBACK_CHARS in lib/feedback/submit.ts (server-only, not imported here).
export const FEEDBACK_MAX = 2000;

type Status = "open" | "fixed" | "closed" | "unknown";
type Item = { number: number; message: string; created_at: string; status: Status };

const STATUS_LABEL: Record<Status, string> = { open: "Open", fixed: "Fixed", closed: "Closed", unknown: "Status unavailable" };

function errorText(status: number): string {
  if (status === 503) return "Feedback is not set up yet.";
  if (status === 429) return "Too many messages, try again in a minute.";
  if (status === 401) return "Sign in to send feedback.";
  return "Could not send. Check your connection and try again.";
}

/** Profile > Feedback: send a message (it becomes a GitHub issue) and see past ones. */
export function FeedbackForm() {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [items, setItems] = useState<Item[]>([]);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/feedback");
      if (!res.ok) return;
      const data = (await res.json()) as { items?: Item[] };
      setItems(Array.isArray(data.items) ? data.items : []);
    } catch {
      // offline or not signed in: no list, the form still works
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const send = async () => {
    setSending(true);
    setMsg(null);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text.trim() }),
      });
      if (res.ok) {
        setText("");
        setMsg({ ok: true, text: "Thanks, your feedback was sent." });
        void load();
      } else {
        setMsg({ ok: false, text: errorText(res.status) });
      }
    } catch {
      setMsg({ ok: false, text: errorText(0) });
    } finally {
      setSending(false);
    }
  };

  const length = [...text].length;
  return (
    <>
      <label className="block">
        <span className="block text-xs text-muted">Ideas, bugs or anything else. Your name and email are not shared.</span>
        <textarea
          className="field mt-2 text-sm"
          rows={4}
          maxLength={FEEDBACK_MAX}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setMsg(null);
          }}
          aria-label="Feedback message"
          placeholder="What would make Lift better?"
        />
      </label>
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted" aria-live="polite">
          {length} / {FEEDBACK_MAX}
        </span>
        <button type="button" className="btn-primary px-5 py-2" disabled={sending || !text.trim()} onClick={send}>
          {sending ? "Sending..." : "Send"}
        </button>
      </div>
      {msg && (
        <p className={`text-sm ${msg.ok ? "" : "text-muted"}`} role="status">
          {msg.text}
        </p>
      )}

      {items.length > 0 && (
        <div>
          <span className="font-semibold block mb-2">Your feedback</span>
          <ul className="space-y-2" aria-label="Your feedback">
            {items.map((i) => (
              <li key={i.number} className="flex items-center justify-between gap-3">
                <span className="min-w-0">
                  <span className="block text-sm truncate">{i.message.split("\n")[0]}</span>
                  <span className="block text-xs text-muted">{new Date(i.created_at).toLocaleDateString()}</span>
                </span>
                <span className={`${i.status === "fixed" ? "chip-on" : "chip"} shrink-0 text-xs`}>{STATUS_LABEL[i.status] ?? STATUS_LABEL.unknown}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
