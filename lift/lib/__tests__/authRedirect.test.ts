import { describe, expect, it } from "vitest";
import { authCallbackUrl, loginPathFor, MAX_NEXT_LENGTH, safeNext } from "../authRedirect";
import { handleAuthCallback } from "../authCallback";

describe("safeNext", () => {
  it("keeps same-origin relative paths with query and hash", () => {
    expect(safeNext("/save?url=https%3A%2F%2Fwww.tiktok.com%2F%40a%2Fvideo%2F1")).toBe(
      "/save?url=https%3A%2F%2Fwww.tiktok.com%2F%40a%2Fvideo%2F1",
    );
    expect(safeNext("/progress")).toBe("/progress");
    expect(safeNext("/history/abc#top")).toBe("/history/abc#top");
  });

  it.each([
    null,
    undefined,
    "",
    "save",
    "https://evil.example/",
    "http://localhost/save",
    "//evil.example/x",
    "///evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "/\tevil",
    "/ /evil",
    "/\n/evil.example",
    "javascript:alert(1)",
    "/login",
    "/login?next=/save",
    "/login/x",
  ])("rejects %j", (raw) => {
    expect(safeNext(raw as string | null | undefined)).toBe("/");
  });

  it("lets percent-encoded slashes stay inside the path (no origin change)", () => {
    const out = safeNext("/%2F%2Fevil.example");
    expect(out.startsWith("/")).toBe(true);
    expect(out.startsWith("//")).toBe(false);
    expect(new URL(out, "https://lift.app").origin).toBe("https://lift.app");
  });

  it("uses the given fallback and caps the length", () => {
    expect(safeNext("https://evil.example", "/home")).toBe("/home");
    expect(safeNext(`/${"a".repeat(MAX_NEXT_LENGTH)}`)).toBe("/");
  });

  it("normalises dot segments without leaving the origin", () => {
    expect(safeNext("/a/../save?url=x")).toBe("/save?url=x");
    expect(safeNext("/../../evil")).toBe("/evil");
  });
});

describe("loginPathFor", () => {
  it("encodes the return path", () => {
    expect(loginPathFor("/save", "?url=https://youtu.be/x")).toBe(`/login?next=${encodeURIComponent("/save?url=https://youtu.be/x")}`);
  });
  it("plain /login for home or unsafe paths", () => {
    expect(loginPathFor("/")).toBe("/login");
    expect(loginPathFor("//evil.example")).toBe("/login");
  });
});

describe("authCallbackUrl", () => {
  it("adds a safe next only", () => {
    expect(authCallbackUrl("https://lift.app", "/save?url=x")).toBe(`https://lift.app/auth/callback?next=${encodeURIComponent("/save?url=x")}`);
    expect(authCallbackUrl("https://lift.app", "https://evil.example")).toBe("https://lift.app/auth/callback");
    expect(authCallbackUrl("https://lift.app", null)).toBe("https://lift.app/auth/callback");
  });
});

describe("handleAuthCallback", () => {
  const req = (q: string) => new Request(`https://lift.app/auth/callback${q}`);
  const ok = async () => null;

  it("exchanges the code and returns to next", async () => {
    let got = "";
    const res = await handleAuthCallback(req(`?code=abc&next=${encodeURIComponent("/save?url=x")}`), async (c) => {
      got = c;
      return null;
    });
    expect(got).toBe("abc");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://lift.app/save?url=x");
  });

  it("never redirects off-origin", async () => {
    for (const next of ["https://evil.example", "//evil.example", "/\\evil.example"]) {
      const res = await handleAuthCallback(req(`?code=abc&next=${encodeURIComponent(next)}`), ok);
      expect(new URL(res.headers.get("location")!).origin).toBe("https://lift.app");
      expect(new URL(res.headers.get("location")!).pathname).toBe("/");
    }
  });

  it("sends a missing, oversized or failing code to /login with the error flag and next", async () => {
    for (const [q, ex] of [
      ["?next=%2Fsave", ok],
      [`?code=${"a".repeat(600)}`, ok],
      ["?code=abc&next=%2Fsave", async () => "expired"],
      ["?code=abc", async () => Promise.reject(new Error("boom"))],
    ] as const) {
      const res = await handleAuthCallback(req(q), ex);
      const loc = new URL(res.headers.get("location")!);
      expect(loc.origin).toBe("https://lift.app");
      expect(loc.pathname).toBe("/login");
      expect(loc.searchParams.get("error")).toBe("link");
      if (q.includes("next")) expect(loc.searchParams.get("next")).toBe("/save");
    }
  });
});
