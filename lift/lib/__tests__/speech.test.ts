import { describe, expect, it } from "vitest";
import {
  MSG_MIC_BLOCKED,
  MSG_MIC_FAILED,
  appendSpoken,
  finalText,
  getRecognition,
  speechError,
  type SpeechEventLike,
} from "@/lib/speech";

const res = (text: string, isFinal: boolean) => ({ isFinal, 0: { transcript: text } });

describe("getRecognition", () => {
  class Std {}
  class Webkit {}
  it("prefers the standard constructor, then the webkit one", () => {
    expect(getRecognition({ SpeechRecognition: Std, webkitSpeechRecognition: Webkit })).toBe(Std);
    expect(getRecognition({ webkitSpeechRecognition: Webkit })).toBe(Webkit);
  });
  it("is null when the browser has neither, or there is no window", () => {
    expect(getRecognition({})).toBeNull();
    expect(getRecognition(undefined)).toBeNull();
  });
});

describe("appendSpoken", () => {
  it("adds one space between typed and spoken text", () => {
    expect(appendSpoken("bench 3x8", "at 60", 100)).toBe("bench 3x8 at 60");
    expect(appendSpoken("bench 3x8   ", "  at   60 ", 100)).toBe("bench 3x8 at 60");
  });
  it("starts from empty and ignores blank speech", () => {
    expect(appendSpoken("", "curls 3x12", 100)).toBe("curls 3x12");
    expect(appendSpoken("bench", "   ", 100)).toBe("bench");
  });
  it("never goes over the cap", () => {
    expect(appendSpoken("a".repeat(8), "bbbbbbbb", 10)).toHaveLength(10);
  });
});

describe("finalText", () => {
  it("keeps only final results from resultIndex on", () => {
    const e: SpeechEventLike = { resultIndex: 1, results: [res("old", true), res("bench press", true), res("three", false)] };
    expect(finalText(e)).toBe("bench press");
  });
  it("is empty with only interim results", () => {
    expect(finalText({ resultIndex: 0, results: [res("be", false)] })).toBe("");
  });
});

describe("speechError", () => {
  it("explains a blocked microphone", () => {
    expect(speechError("not-allowed")).toBe(MSG_MIC_BLOCKED);
    expect(speechError("service-not-allowed")).toBe(MSG_MIC_BLOCKED);
  });
  it("stays quiet for silence or a manual stop", () => {
    expect(speechError("no-speech")).toBeNull();
    expect(speechError("aborted")).toBeNull();
  });
  it("gives a plain message for anything else", () => {
    expect(speechError("network")).toBe(MSG_MIC_FAILED);
  });
});
