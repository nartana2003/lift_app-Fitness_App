import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createRateLimiter } from "../../ai/guard";
import {
  buildFeedbackIssue,
  feedbackStatus,
  githubFeedback,
  handleFeedbackList,
  handleFeedbackSubmit,
  MAX_FEEDBACK_BYTES,
  MAX_FEEDBACK_CHARS,
  parseFeedbackBody,
  supabaseFeedbackStore,
  type FeedbackDeps,
  type FeedbackGithub,
  type FeedbackIssue,
  type FeedbackRow,
  type FeedbackStore,
  type GithubIssueState,
} from "../submit";

// Mocked user lookup, GitHub and store: no Supabase project, no network.

const USER = "1234abcd-5678-90ef-aaaa-bbbbccccdddd";
const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  GITHUB_FEEDBACK_TOKEN: "github_pat_x",
};
const LOCAL_ENV = { GITHUB_FEEDBACK_TOKEN: "github_pat_x" };

function setup(o: Partial<FeedbackDeps> = {}, gh: Partial<FeedbackGithub> = {}, st: Partial<FeedbackStore> = {}) {
  const created: FeedbackIssue[] = [];
  const saved: [number, string][] = [];
  const rows: FeedbackRow[] = [];
  const github: FeedbackGithub = {
    create: async (i) => (created.push(i), 42),
    states: async () => [],
    ...gh,
  };
  const store: FeedbackStore = {
    save: async (n, m) => void saved.push([n, m]),
    list: async () => rows,
    ...st,
  };
  const deps: FeedbackDeps = {
    env: ENV,
    resolveUser: async () => ({ id: USER }),
    github: () => github,
    store: async () => store,
    limiter: createRateLimiter([{ windowMs: 60_000, max: 100 }]),
    ...o,
  };
  return { deps, created, saved, rows };
}

const post = (body: unknown) =>
  new Request("http://localhost/api/feedback", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("parseFeedbackBody", () => {
  it("accepts { message } and trims it", () => {
    expect(parseFeedbackBody({ message: "  Love it  " })).toBe("Love it");
  });

  it("rejects unknown keys, wrong types, blank and over-long messages", () => {
    expect(parseFeedbackBody({ message: "hi", email: "a@b.c" })).toBeNull();
    expect(parseFeedbackBody({ message: 5 })).toBeNull();
    expect(parseFeedbackBody({})).toBeNull();
    expect(parseFeedbackBody(["hi"])).toBeNull();
    expect(parseFeedbackBody(null)).toBeNull();
    expect(parseFeedbackBody({ message: "   \n " })).toBeNull();
    expect(parseFeedbackBody({ message: "a".repeat(MAX_FEEDBACK_CHARS) })).toHaveLength(MAX_FEEDBACK_CHARS);
    expect(parseFeedbackBody({ message: "a".repeat(MAX_FEEDBACK_CHARS + 1) })).toBeNull();
  });
});

describe("buildFeedbackIssue", () => {
  it("titles from the first line, labels not planned, and names only a short user id", () => {
    const issue = buildFeedbackIssue("Rest timer too quiet\nOn my phone it is hard to hear.", USER);
    expect(issue.title).toBe("Feedback: Rest timer too quiet");
    expect(issue.labels).toEqual(["feedback", "not planned"]);
    expect(issue.body).toContain("On my phone it is hard to hear.");
    expect(issue.body).toContain("From user 1234abcd.");
    expect(issue.body).not.toContain(USER);
  });

  it("truncates a long first line to 60 characters", () => {
    const issue = buildFeedbackIssue("x".repeat(200), USER);
    const short = issue.title.replace("Feedback: ", "");
    expect(short.length).toBe(60);
    expect(short.endsWith("...")).toBe(true);
  });

  it("marks local-only senders", () => {
    expect(buildFeedbackIssue("hi", null).body).toContain("From a local-only user.");
  });
});

describe("feedbackStatus", () => {
  it("maps GitHub state and reason", () => {
    expect(feedbackStatus({ number: 1, state: "open" })).toBe("open");
    expect(feedbackStatus({ number: 1, state: "closed", state_reason: "completed" })).toBe("fixed");
    expect(feedbackStatus({ number: 1, state: "closed", state_reason: "not_planned" })).toBe("closed");
    expect(feedbackStatus({ number: 1, state: "closed", state_reason: null })).toBe("closed");
    expect(feedbackStatus(undefined)).toBe("unknown");
  });
});

describe("handleFeedbackSubmit", () => {
  it("creates the issue and saves the link for the signed-in user", async () => {
    const { deps, created, saved } = setup();
    const res = await handleFeedbackSubmit(post({ message: "Add dark mode" }), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, number: 42 });
    expect(created).toHaveLength(1);
    expect(created[0].title).toBe("Feedback: Add dark mode");
    expect(saved).toEqual([[42, "Add dark mode"]]);
  });

  it("503 without GITHUB_FEEDBACK_TOKEN, before reading the body", async () => {
    for (const token of [undefined, "", "   "]) {
      const { deps, created } = setup({ env: { ...ENV, GITHUB_FEEDBACK_TOKEN: token } });
      const res = await handleFeedbackSubmit(post("not json"), deps);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ unavailable: true });
      expect(created).toHaveLength(0);
    }
  });

  it("401 when Supabase is configured and nobody is signed in, or the lookup throws", async () => {
    for (const resolveUser of [async () => null, async () => ({ id: " " }), async () => Promise.reject(new Error("down"))]) {
      const { deps, created } = setup({ resolveUser });
      const res = await handleFeedbackSubmit(post({ message: "hi" }), deps);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
      expect(created).toHaveLength(0);
    }
  });

  it("local-only mode skips sign-in and stores nothing", async () => {
    const resolveUser = vi.fn(async () => null);
    const { deps, created, saved } = setup({ env: LOCAL_ENV, resolveUser });
    const res = await handleFeedbackSubmit(post({ message: "hi" }), deps);
    expect(res.status).toBe(200);
    expect(resolveUser).not.toHaveBeenCalled();
    expect(created[0].body).toContain("From a local-only user.");
    expect(saved).toEqual([]);
  });

  it("429 over the per-user limit", async () => {
    const { deps } = setup({ limiter: createRateLimiter([{ windowMs: 60_000, max: 1 }]) });
    expect((await handleFeedbackSubmit(post({ message: "one" }), deps)).status).toBe(200);
    const res = await handleFeedbackSubmit(post({ message: "two" }), deps);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  it("400 for bad JSON, unknown keys or a blank message; 413 over the byte cap", async () => {
    const { deps, created } = setup();
    expect((await handleFeedbackSubmit(post("{nope"), deps)).status).toBe(400);
    expect((await handleFeedbackSubmit(post({ message: "hi", user_id: "x" }), deps)).status).toBe(400);
    expect((await handleFeedbackSubmit(post({ message: "  " }), deps)).status).toBe(400);
    expect((await handleFeedbackSubmit(post({ message: "a".repeat(MAX_FEEDBACK_CHARS + 1) }), deps)).status).toBe(400);
    expect((await handleFeedbackSubmit(post({ message: "a".repeat(MAX_FEEDBACK_BYTES) }), deps)).status).toBe(413);
    expect(created).toHaveLength(0);
  });

  it("500 when GitHub fails, and nothing is saved", async () => {
    const { deps, saved } = setup({}, { create: async () => Promise.reject(new Error("github 403")) });
    const res = await handleFeedbackSubmit(post({ message: "hi" }), deps);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "failed" });
    expect(saved).toEqual([]);
  });

  it("still 200 when the issue was created but saving the link fails", async () => {
    const { deps } = setup({}, {}, { save: async () => Promise.reject(new Error("rls")) });
    const res = await handleFeedbackSubmit(post({ message: "hi" }), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, number: 42 });
  });
});

describe("handleFeedbackList", () => {
  const row = (n: number): FeedbackRow => ({ issue_number: n, message: `m${n}`, created_at: "2026-11-01T10:00:00Z" });

  it("empty list in local-only mode", async () => {
    const { deps } = setup({ env: LOCAL_ENV });
    expect(await (await handleFeedbackList(deps)).json()).toEqual({ items: [] });
  });

  it("401 with no user", async () => {
    const { deps } = setup({ resolveUser: async () => null });
    expect((await handleFeedbackList(deps)).status).toBe(401);
  });

  it("merges each row with its GitHub status", async () => {
    const states: GithubIssueState[] = [
      { number: 1, state: "open" },
      { number: 2, state: "closed", state_reason: "completed" },
      { number: 3, state: "closed", state_reason: "not_planned" },
    ];
    const { deps, rows } = setup({}, { states: async () => states });
    rows.push(row(1), row(2), row(3), row(4));
    const { items } = await (await handleFeedbackList(deps)).json();
    expect(items.map((i: { number: number; status: string }) => [i.number, i.status])).toEqual([
      [1, "open"],
      [2, "fixed"],
      [3, "closed"],
      [4, "unknown"],
    ]);
    expect(items[0]).toEqual({ number: 1, message: "m1", created_at: "2026-11-01T10:00:00Z", status: "open" });
  });

  it("every item is unknown when GitHub fails or no token is set", async () => {
    const failing = setup({}, { states: async () => Promise.reject(new Error("down")) });
    failing.rows.push(row(1));
    expect((await (await handleFeedbackList(failing.deps)).json()).items[0].status).toBe("unknown");

    const states = vi.fn(async () => [{ number: 1, state: "open" }]);
    const noToken = setup({ env: { ...ENV, GITHUB_FEEDBACK_TOKEN: undefined } }, { states });
    noToken.rows.push(row(1));
    expect((await (await handleFeedbackList(noToken.deps)).json()).items[0].status).toBe("unknown");
    expect(states).not.toHaveBeenCalled();
  });

  it("500 when the store fails", async () => {
    const { deps } = setup({}, {}, { list: async () => Promise.reject(new Error("db")) });
    expect((await handleFeedbackList(deps)).status).toBe(500);
  });
});

describe("githubFeedback", () => {
  it("POSTs the issue with the token and API version, and returns its number", async () => {
    const fetchFn = vi.fn(async () => Response.json({ number: 7 }, { status: 201 }));
    const gh = githubFeedback("tok", "me/repo", fetchFn as unknown as typeof fetch);
    expect(await gh.create({ title: "t", body: "b", labels: ["feedback", "not planned"] })).toBe(7);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/me/repo/issues");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer tok",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    });
    expect(JSON.parse(init.body as string)).toEqual({ title: "t", body: "b", labels: ["feedback", "not planned"] });
  });

  it("throws on a non-2xx answer or a missing number", async () => {
    const bad = githubFeedback("tok", "me/repo", (async () => new Response("no", { status: 403 })) as unknown as typeof fetch);
    await expect(bad.create({ title: "t", body: "b", labels: [] })).rejects.toThrow();
    const odd = githubFeedback("tok", "me/repo", (async () => Response.json({})) as unknown as typeof fetch);
    await expect(odd.create({ title: "t", body: "b", labels: [] })).rejects.toThrow();
  });

  it("lists feedback issue states and drops malformed entries", async () => {
    const fetchFn = vi.fn(async () => Response.json([{ number: 1, state: "open" }, { state: "open" }, "junk"]));
    const gh = githubFeedback("tok", "me/repo", fetchFn as unknown as typeof fetch);
    expect(await gh.states()).toEqual([{ number: 1, state: "open" }]);
    expect((fetchFn.mock.calls[0] as unknown as [string])[0]).toBe("https://api.github.com/repos/me/repo/issues?labels=feedback&state=all&per_page=100");
  });
});

describe("supabaseFeedbackStore", () => {
  it("inserts and lists through the user's client", async () => {
    const insert = vi.fn(async () => ({ error: null }));
    const limit = vi.fn(async () => ({ data: [{ issue_number: 1, message: "m", created_at: "t" }], error: null }));
    const order = vi.fn(() => ({ limit }));
    const select = vi.fn(() => ({ order }));
    const client = { from: vi.fn(() => ({ insert, select })) } as unknown as SupabaseClient;
    const store = supabaseFeedbackStore(client);
    await store.save(5, "hello");
    expect(insert).toHaveBeenCalledWith({ issue_number: 5, message: "hello" });
    expect(await store.list()).toEqual([{ issue_number: 1, message: "m", created_at: "t" }]);
    expect(order).toHaveBeenCalledWith("created_at", { ascending: false });
    expect(limit).toHaveBeenCalledWith(20);
  });

  it("throws on a Supabase error", async () => {
    const client = { from: () => ({ insert: async () => ({ error: { message: "x" } }) }) } as unknown as SupabaseClient;
    await expect(supabaseFeedbackStore(client).save(1, "m")).rejects.toThrow();
  });
});
