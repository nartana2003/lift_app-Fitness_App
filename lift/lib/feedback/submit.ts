/**
 * Server-only. /api/feedback: POST turns an in-app message into a GitHub issue
 * labeled "feedback" and "not planned" (the daily-issue workflow skips "not
 * planned", so feedback is never auto-fixed). GET lists the signed-in user's
 * past feedback with its issue status, so they can see when it was fixed.
 *
 * POST order: config (503 {unavailable:true} without GITHUB_FEEDBACK_TOKEN) ->
 * sign-in when Supabase is configured (401, same resolver as the AI routes,
 * lib/ai/guard.ts; local-only mode has no accounts, as in guardAiRequest) ->
 * per-user rate limit (429) -> body with a byte cap (400/413) -> strict
 * validation (400) -> create the issue (500 on failure) -> save the link.
 *
 * The repo is public, so the issue body never carries the user's email or
 * name: only the first 8 characters of their user id.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { aiRateLimited, aiUnauthorized, createRateLimiter, supabaseConfiguredFrom, type AiUserResolver, type RateLimiter } from "../ai/guard";
import { invalidRequest, readJsonBody } from "../ai/request";

export type FeedbackEnv = Record<string, string | undefined>;

export const MAX_FEEDBACK_CHARS = 2000;
export const MAX_FEEDBACK_BYTES = 16_384;
export const MAX_TITLE_CHARS = 60;
export const FEEDBACK_LABELS = ["feedback", "not planned"] as const;
export const DEFAULT_FEEDBACK_REPO = "nartana2003/lift_app-Fitness_App";

export type FeedbackIssue = { title: string; body: string; labels: string[] };
export type FeedbackStatus = "open" | "fixed" | "closed" | "unknown";
export type FeedbackRow = { issue_number: number; message: string; created_at: string };
export type FeedbackItem = { number: number; message: string; created_at: string; status: FeedbackStatus };
export type GithubIssueState = { number: number; state: string; state_reason?: string | null };

export interface FeedbackStore {
  save(issueNumber: number, message: string): Promise<void>;
  list(): Promise<FeedbackRow[]>;
}

export interface FeedbackGithub {
  create(issue: FeedbackIssue): Promise<number>;
  states(): Promise<GithubIssueState[]>;
}

export type FeedbackDeps = {
  env: FeedbackEnv;
  resolveUser: AiUserResolver;
  github: () => FeedbackGithub;
  store: () => Promise<FeedbackStore>;
  limiter: RateLimiter;
};

/** Small limiter: feedback is a rare, user-initiated action. */
export const createFeedbackLimiter = () => createRateLimiter([{ windowMs: 60_000, max: 5 }]);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** POST body: { message }, trimmed, 1 to MAX_FEEDBACK_CHARS characters. */
export function parseFeedbackBody(v: unknown): string | null {
  if (!isObj(v) || Object.keys(v).some((k) => k !== "message")) return null;
  if (typeof v.message !== "string") return null;
  const message = v.message.trim();
  if (!message || [...message].length > MAX_FEEDBACK_CHARS) return null;
  return message;
}

export function buildFeedbackIssue(message: string, userId: string | null): FeedbackIssue {
  const firstLine = message.split(/\r?\n/)[0].trim();
  const chars = [...firstLine];
  const short = chars.length > MAX_TITLE_CHARS ? `${chars.slice(0, MAX_TITLE_CHARS - 3).join("").trimEnd()}...` : firstLine;
  const from = userId ? `From user ${userId.slice(0, 8)}` : "From a local-only user";
  return {
    title: `Feedback: ${short}`,
    body: `${message}\n\n---\n${from}. Sent from the in-app feedback form.`,
    labels: [...FEEDBACK_LABELS],
  };
}

export function feedbackStatus(issue: GithubIssueState | undefined): FeedbackStatus {
  if (!issue) return "unknown";
  if (issue.state === "open") return "open";
  if (issue.state === "closed") return issue.state_reason === "completed" ? "fixed" : "closed";
  return "unknown";
}

const feedbackConfigured = (env: FeedbackEnv) => Boolean(env.GITHUB_FEEDBACK_TOKEN?.trim());

async function signedInUser(deps: FeedbackDeps): Promise<{ id: string } | null> {
  try {
    const user = await deps.resolveUser();
    return user && typeof user.id === "string" && user.id.trim() ? user : null;
  } catch {
    return null;
  }
}

export async function handleFeedbackSubmit(req: Request, deps: FeedbackDeps): Promise<Response> {
  const { env } = deps;
  if (!feedbackConfigured(env)) return Response.json({ unavailable: true }, { status: 503 });
  const accounts = supabaseConfiguredFrom(env);
  const user = accounts ? await signedInUser(deps) : null;
  if (accounts && !user) return aiUnauthorized();
  const limited = deps.limiter.check(user?.id ?? "local");
  if (!limited.ok) return aiRateLimited(limited.retryAfterSec);

  const body = await readJsonBody(req, MAX_FEEDBACK_BYTES);
  if (!body.ok) return invalidRequest(body.status);
  const message = parseFeedbackBody(body.value);
  if (!message) return invalidRequest();

  let number: number;
  try {
    number = await deps.github().create(buildFeedbackIssue(message, user?.id ?? null));
  } catch {
    return Response.json({ error: "failed" }, { status: 500 });
  }
  if (user) {
    // The issue already exists, so a failed save still counts as sent.
    try {
      await (await deps.store()).save(number, message);
    } catch {
      // the status list just misses this one
    }
  }
  return Response.json({ ok: true, number });
}

export async function handleFeedbackList(deps: FeedbackDeps): Promise<Response> {
  if (!supabaseConfiguredFrom(deps.env)) return Response.json({ items: [] });
  if (!(await signedInUser(deps))) return aiUnauthorized();
  let rows: FeedbackRow[];
  try {
    rows = await (await deps.store()).list();
  } catch {
    return Response.json({ error: "failed" }, { status: 500 });
  }
  let states: GithubIssueState[] = [];
  if (rows.length && feedbackConfigured(deps.env)) {
    try {
      states = await deps.github().states();
    } catch {
      // every item shows as unknown
    }
  }
  const byNumber = new Map(states.map((s) => [s.number, s]));
  const items: FeedbackItem[] = rows.map((r) => ({
    number: r.issue_number,
    message: r.message,
    created_at: r.created_at,
    status: feedbackStatus(byNumber.get(r.issue_number)),
  }));
  return Response.json({ items });
}

/** FeedbackGithub on the GitHub REST API with a fine-grained token (Issues: read and write). */
export function githubFeedback(token: string, repo: string, fetchFn: typeof fetch = fetch): FeedbackGithub {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const base = `https://api.github.com/repos/${repo}/issues`;
  return {
    async create(issue) {
      const res = await fetchFn(base, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(issue) });
      if (!res.ok) throw new Error(`github ${res.status}`);
      const data = (await res.json()) as { number?: unknown };
      if (typeof data.number !== "number") throw new Error("github: no issue number");
      return data.number;
    },
    async states() {
      const res = await fetchFn(`${base}?labels=feedback&state=all&per_page=100`, { headers });
      if (!res.ok) throw new Error(`github ${res.status}`);
      const data = (await res.json()) as unknown;
      if (!Array.isArray(data)) throw new Error("github: not a list");
      return data.filter((i): i is GithubIssueState => isObj(i) && typeof i.number === "number" && typeof i.state === "string");
    },
  };
}

/** FeedbackStore on the signed-in user's client, so RLS "own rows" applies. */
export function supabaseFeedbackStore(client: SupabaseClient): FeedbackStore {
  return {
    async save(issueNumber, message) {
      const { error } = await client.from("feedback").insert({ issue_number: issueNumber, message });
      if (error) throw new Error("insert failed");
    },
    async list() {
      const { data, error } = await client
        .from("feedback")
        .select("issue_number, message, created_at")
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw new Error("select failed");
      return (data ?? []) as FeedbackRow[];
    },
  };
}
