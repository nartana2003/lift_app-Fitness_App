// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { db } from "@/lib/offline/db";
import { saveEquipment } from "@/lib/equipment";
import type { Exercise } from "@/lib/exercises";
import type { Equipment } from "@/lib/muscles";
import {
  SWAP_AI,
  SwapSheet,
  buildSwapRequest,
  cleanSwapReason,
  parseSwapResponse,
  resetSwapAi,
} from "@/components/workout/SwapSheet";

const ex = (id: string, name: string, equipment: Equipment, over: Partial<Exercise> = {}): Exercise => ({
  id,
  name,
  muscle_groups: ["Chest"],
  secondary_groups: [],
  equipment,
  category: "strength",
  mechanic: "compound",
  force: "push",
  level: "beginner",
  instructions: [],
  image_urls: [],
  tiktok_url: "",
  ...over,
});

const bench = ex("bench", "Bench Press", "Barbell");
const dbPress = ex("db_press", "Dumbbell Press", "Dumbbell");
const pushUp = ex("push_up", "Push-Up", "Bodyweight");
const cableFly = ex("cable_fly", "Cable Fly", "Machine/Cable", { mechanic: "isolation" });
const squat = ex("squat", "Back Squat", "Barbell", { muscle_groups: ["Quads"] });
const CATALOGUE = [bench, dbPress, pushUp, cableFly, squat];

const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const AI_BODY = {
  exercise_id: "bench",
  alternatives: [
    { exercise_id: "cable_fly", reason: "Same chest work on a cable, free right now.", source: "ai" },
    { exercise_id: "push_up", reason: "Needs no equipment at all.", source: "ai" },
  ],
  adjusted: 0,
};

let fetchMock: ReturnType<typeof vi.fn>;
/** Routes the catalogue fetch to the fixture list and the AI call to `ai`. */
function mockFetch(ai: () => Promise<Response>) {
  fetchMock.mockImplementation((url: string) =>
    url === "/exercises.json" ? Promise.resolve(jsonRes(200, CATALOGUE)) : ai(),
  );
}
const aiCalls = () => fetchMock.mock.calls.filter(([url]) => url === "/api/ai/swap-exercise");
const settle = () => new Promise((r) => setTimeout(r, 20));

function renderSheet() {
  const onPick = vi.fn();
  const onClose = vi.fn();
  render(<SwapSheet current={bench} onPick={onPick} onClose={onClose} />);
  return { onPick, onClose };
}

/** Rule-based list: the names in the unlabelled list (outside Coach picks). */
async function ruleNames() {
  await screen.findByRole("button", { name: /Dumbbell Press/ });
  const lists = screen.getAllByRole("list");
  const rule = lists[lists.length - 1];
  return within(rule).getAllByRole("button").map((b) => b.querySelector(".font-medium")?.textContent);
}

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  resetSwapAi();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SwapSheet: AI picks", () => {
  it("adds Coach picks with a reason each above the unchanged rule-based list", async () => {
    mockFetch(() => Promise.resolve(jsonRes(200, AI_BODY)));
    const { onPick } = renderSheet();

    const section = await screen.findByRole("region", { name: "Coach picks" });
    expect(within(section).getByText("Same chest work on a cable, free right now.")).toBeInTheDocument();
    expect(within(section).getByText("Needs no equipment at all.")).toBeInTheDocument();
    const names = within(section).getAllByRole("button").map((b) => b.querySelector(".font-medium")?.textContent);
    expect(names).toEqual(["Cable Fly", "Push-Up"]);

    // The rule list still holds every same-muscle alternative, never the current one or other muscles.
    const rule = await ruleNames();
    expect(new Set(rule)).toEqual(new Set(["Dumbbell Press", "Push-Up", "Cable Fly"]));

    // Request: catalogue id, reason, full gym sent as [].
    expect(aiCalls()).toHaveLength(1);
    const [, init] = aiCalls()[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ exercise_id: "bench", reason: "busy", equipment: [] });

    fireEvent.click(within(section).getByRole("button", { name: /Cable Fly/ }));
    expect(onPick).toHaveBeenCalledWith(cableFly);
  });

  it("asks again with the new reason and sends the saved gym equipment", async () => {
    await saveEquipment(["Dumbbell", "Bodyweight"]);
    mockFetch(() => Promise.resolve(jsonRes(200, AI_BODY)));
    renderSheet();
    await screen.findByRole("region", { name: "Coach picks" });
    fireEvent.click(screen.getByRole("button", { name: "It hurts" }));
    await waitFor(() => expect(aiCalls()).toHaveLength(2));
    const body = JSON.parse((aiCalls()[1][1] as RequestInit).body as string);
    expect(body).toEqual({ exercise_id: "bench", reason: "hurts", equipment: ["Dumbbell", "Bodyweight"] });
  });

  it("hides Coach picks while searching", async () => {
    mockFetch(() => Promise.resolve(jsonRes(200, AI_BODY)));
    renderSheet();
    await screen.findByRole("region", { name: "Coach picks" });
    fireEvent.change(screen.getByPlaceholderText("Or search for one"), { target: { value: "squat" } });
    expect(screen.queryByRole("region", { name: "Coach picks" })).toBeNull();
    expect(await screen.findByRole("button", { name: /Back Squat/ })).toBeInTheDocument();
  });

  it("drops picks the local catalogue does not know", async () => {
    mockFetch(() =>
      Promise.resolve(
        jsonRes(200, { exercise_id: "bench", alternatives: [{ exercise_id: "made_up", reason: "Invented.", source: "ai" }] }),
      ),
    );
    renderSheet();
    await waitFor(() => expect(aiCalls()).toHaveLength(1));
    await settle();
    expect(screen.queryByRole("region", { name: "Coach picks" })).toBeNull();
    expect(screen.queryByText("Invented.")).toBeNull();
  });

  it("on 503 shows the rule-based list unchanged and stops asking", async () => {
    mockFetch(() => Promise.resolve(jsonRes(503, { unavailable: true })));
    renderSheet();
    await waitFor(() => expect(aiCalls()).toHaveLength(1));
    await settle();
    expect(screen.queryByRole("region", { name: "Coach picks" })).toBeNull();
    expect(screen.queryByText("Ranking alternatives…")).toBeNull();
    expect(new Set(await ruleNames())).toEqual(new Set(["Dumbbell Press", "Push-Up", "Cable Fly"]));

    fireEvent.click(screen.getByRole("button", { name: "Want variety" }));
    await settle();
    expect(aiCalls()).toHaveLength(1);
  });

  it.each<[string, () => Promise<Response>]>([
    ["a 500", () => Promise.resolve(jsonRes(500, { error: "error" }))],
    ["a network failure", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["a malformed body", () => Promise.resolve(jsonRes(200, { nope: true }))],
    ["an answer for another exercise", () => Promise.resolve(jsonRes(200, { ...AI_BODY, exercise_id: "squat" }))],
  ])("on %s shows the rule-based list unchanged", async (_, ai) => {
    mockFetch(ai);
    renderSheet();
    await waitFor(() => expect(aiCalls()).toHaveLength(1));
    await settle();
    expect(screen.queryByRole("region", { name: "Coach picks" })).toBeNull();
    expect(screen.queryByText("Ranking alternatives…")).toBeNull();
    expect(new Set(await ruleNames())).toEqual(new Set(["Dumbbell Press", "Push-Up", "Cable Fly"]));
  });

  it("does not ask when offline", async () => {
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    try {
      mockFetch(() => Promise.resolve(jsonRes(200, AI_BODY)));
      renderSheet();
      expect(new Set(await ruleNames())).toEqual(new Set(["Dumbbell Press", "Push-Up", "Cable Fly"]));
      await settle();
      expect(aiCalls()).toHaveLength(0);
    } finally {
      online.mockRestore();
    }
  });

  it("reuses a cached answer when reopened", async () => {
    mockFetch(() => Promise.resolve(jsonRes(200, AI_BODY)));
    const first = render(<SwapSheet current={bench} onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole("region", { name: "Coach picks" });
    first.unmount();
    renderSheet();
    expect(await screen.findByRole("region", { name: "Coach picks" })).toBeInTheDocument();
    expect(aiCalls()).toHaveLength(1);
  });
});

describe("parseSwapResponse", () => {
  it("keeps valid picks in order", () => {
    expect(parseSwapResponse(AI_BODY, "bench")).toEqual([
      { exercise_id: "cable_fly", reason: "Same chest work on a cable, free right now." },
      { exercise_id: "push_up", reason: "Needs no equipment at all." },
    ]);
  });

  it("rejects unusable bodies", () => {
    expect(parseSwapResponse(null, "bench")).toBeNull();
    expect(parseSwapResponse("x", "bench")).toBeNull();
    expect(parseSwapResponse({ exercise_id: "bench" }, "bench")).toBeNull();
    expect(parseSwapResponse({ ...AI_BODY, exercise_id: "other" }, "bench")).toBeNull();
  });

  it("drops bad items, duplicates and the exercise itself, and caps the count", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ exercise_id: `x${i}`, reason: `R${i}` }));
    const out = parseSwapResponse(
      {
        exercise_id: "bench",
        alternatives: [
          null,
          "push_up",
          { exercise_id: 7, reason: "num" },
          { exercise_id: "", reason: "empty" },
          { exercise_id: "a".repeat(SWAP_AI.maxId + 1), reason: "long" },
          { exercise_id: "bench", reason: "self" },
          { exercise_id: "push_up", reason: "   " },
          { exercise_id: "push_up", reason: "first" },
          { exercise_id: "push_up", reason: "dupe" },
          ...many,
        ],
      },
      "bench",
    )!;
    expect(out).toHaveLength(SWAP_AI.maxAlternatives);
    expect(out[0]).toEqual({ exercise_id: "push_up", reason: "first" });
    expect(out.map((p) => p.exercise_id)).toEqual(["push_up", "x0", "x1", "x2", "x3", "x4"]);
  });
});

describe("cleanSwapReason", () => {
  it("strips control characters and emoji, collapses spaces and caps length", () => {
    expect(cleanSwapReason("Easier\u0000 on the\n shoulder \u{1F4AA}")).toBe("Easier on the shoulder");
    expect(cleanSwapReason("a".repeat(500))).toHaveLength(SWAP_AI.maxReason);
    expect(cleanSwapReason("\u{1F525}")).toBeNull();
    expect(cleanSwapReason(5)).toBeNull();
  });
});

describe("buildSwapRequest", () => {
  it("builds the route body and refuses unusable ids or reasons", () => {
    expect(buildSwapRequest("bench", "equipment", ["Dumbbell"])).toEqual({
      exercise_id: "bench",
      reason: "equipment",
      equipment: ["Dumbbell"],
    });
    expect(buildSwapRequest("", "busy", [])).toBeNull();
    expect(buildSwapRequest("a".repeat(SWAP_AI.maxId + 1), "busy", [])).toBeNull();
    expect(buildSwapRequest("bench", "nope" as never, [])).toBeNull();
  });
});
