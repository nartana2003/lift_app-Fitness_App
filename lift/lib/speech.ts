// Browser speech recognition for Quick log. Chrome and Edge only; the audio is
// handled by the browser's own service, so it needs a connection. Where it is
// missing the mic button simply does not show.

type Alt = { transcript: string };
type Result = { isFinal: boolean; 0: Alt };
export type SpeechEventLike = { resultIndex: number; results: ArrayLike<Result> };

export interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SpeechEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

type RecognitionCtor = new () => Recognition;

/** The browser's recognition constructor (standard or webkit-prefixed), or null. */
export function getRecognition(win: unknown = typeof window === "undefined" ? undefined : window): RecognitionCtor | null {
  const w = win as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor } | undefined;
  return w?.SpeechRecognition ?? w?.webkitSpeechRecognition ?? null;
}

/** Appends spoken text to what is already typed: one space between, trimmed, capped. */
export function appendSpoken(existing: string, spoken: string, max: number): string {
  const add = spoken.replace(/\s+/g, " ").trim();
  if (!add) return existing;
  const base = existing.trimEnd();
  return (base ? `${base} ${add}` : add).slice(0, max);
}

/** The final (not interim) text of the results that arrived in this event. */
export function finalText(e: SpeechEventLike): string {
  let out = "";
  for (let i = e.resultIndex; i < e.results.length; i++) {
    if (e.results[i].isFinal) out += ` ${e.results[i][0].transcript}`;
  }
  return out.trim();
}

export const MSG_MIC_BLOCKED = "Microphone access is blocked. Allow it in your browser settings, or type instead.";
export const MSG_MIC_FAILED = "Could not hear that. Try again, or type instead.";

/** Plain message for a recognition error code; null when nothing needs saying. */
export function speechError(code: string): string | null {
  if (code === "not-allowed" || code === "service-not-allowed") return MSG_MIC_BLOCKED;
  if (code === "aborted" || code === "no-speech") return null;
  return MSG_MIC_FAILED;
}
