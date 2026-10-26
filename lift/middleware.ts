import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { supabaseConfigured } from "@/lib/supabase/configured";
import { isCronAuthorized, isCronPath } from "@/lib/cronAuth";
import { NEXT_PARAM, safeNext } from "@/lib/authRedirect";

// /api/cron is not on this list: cron routes have no user session and are
// gated by CRON_SECRET below instead of being open to everyone.
const PUBLIC = ["/login", "/auth", "/manifest.webmanifest", "/sw.js", "/icons"];

export async function middleware(request: NextRequest) {
  // Cron routes: require `Authorization: Bearer <CRON_SECRET>` in every mode,
  // including local-only. Route handlers must also check it (lib/cronAuth.ts).
  if (isCronPath(request.nextUrl.pathname)) {
    if (!isCronAuthorized(request.headers.get("authorization"), process.env.CRON_SECRET)) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return NextResponse.next({ request });
  }

  let response = NextResponse.next({ request });
  if (!supabaseConfigured) return response; // local-only mode until keys are added

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet) => {
          toSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          toSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  // AI routes are fetched by the app, not navigated to: answer 401 JSON (the
  // client then keeps its rule-based fallback) instead of a login redirect.
  // withAiClient (lib/ai/guard.ts) checks the session again in the route.
  // Same for the push subscription route (lib/push/subscribe.ts checks again).
  if (!user && (path.startsWith("/api/ai/") || path.startsWith("/api/push/"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!user && !PUBLIC.some((p) => path.startsWith(p))) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    // Return-to (lib/authRedirect.ts): after sign-in the user comes back here,
    // e.g. /save?url=... from the iOS Shortcut. Pages only, never /api.
    if (!path.startsWith("/api/")) {
      const next = safeNext(`${path}${request.nextUrl.search}`, "");
      if (next && next !== "/") url.searchParams.set(NEXT_PARAM, next);
    }
    return NextResponse.redirect(url);
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|svg|webp)$).*)"],
};
