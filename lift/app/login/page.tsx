"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { authCallbackUrl, NEXT_PARAM, safeNext } from "@/lib/authRedirect";

function PasswordField({
  value,
  onChange,
  placeholder,
  autoComplete,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  autoComplete: string;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <input
        className="field pr-12"
        type={shown ? "text" : "password"}
        autoComplete={autoComplete}
        placeholder={placeholder}
        minLength={6}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
      />
      <button
        type="button"
        aria-label={shown ? "Hide password" : "Show password"}
        aria-pressed={shown}
        onClick={() => setShown(!shown)}
        className="absolute inset-y-0 right-0 w-12 flex items-center justify-center text-muted"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
          <circle cx="12" cy="12" r="3" />
          {shown && <path d="M3 3l18 18" />}
        </svg>
      </button>
    </div>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // /auth/callback sends an expired or reused confirmation link back here.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("error") === "link") {
      setMsg("That link did not work. Sign in, or create the account again.");
    }
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (mode === "signup" && password !== confirm) return setMsg("Passwords do not match.");
    setBusy(true);
    const supabase = supabaseBrowser();
    // Return-to: only a same-origin relative path is ever used (lib/authRedirect.ts).
    const next = safeNext(new URLSearchParams(window.location.search).get(NEXT_PARAM));
    const { data, error } =
      mode === "signin"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({
            email,
            password,
            options: { emailRedirectTo: authCallbackUrl(window.location.origin, next) },
          });
    setBusy(false);
    if (error) return setMsg(error.message);
    if (mode === "signup" && !data.session) {
      return setMsg("Check your email to confirm your account, then sign in.");
    }
    router.replace(next);
    router.refresh();
  }

  return (
    <main className="pt-safe min-h-dvh flex flex-col justify-center px-6 max-w-md mx-auto">
      <h1 className="text-5xl font-black text-accent tracking-tight">Lift</h1>
      <p className="text-muted mt-2 mb-10">Track every rep. See every gain.</p>

      <form onSubmit={submit} className="space-y-3">
        <input
          className="field"
          type="email"
          autoComplete="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <PasswordField
          value={password}
          onChange={setPassword}
          placeholder="Password"
          autoComplete={mode === "signin" ? "current-password" : "new-password"}
        />
        {mode === "signup" && (
          <PasswordField
            value={confirm}
            onChange={setConfirm}
            placeholder="Confirm password"
            autoComplete="new-password"
          />
        )}
        <button className="btn-primary w-full" disabled={busy}>
          {busy ? "…" : mode === "signin" ? "Sign in" : "Create account"}
        </button>
      </form>

      {msg && <p className="mt-4 text-sm text-warn">{msg}</p>}

      <button
        className="mt-6 text-sm text-muted"
        onClick={() => {
          setMode(mode === "signin" ? "signup" : "signin");
          setConfirm("");
          setMsg(null);
        }}
      >
        {mode === "signin" ? "New here? Create an account" : "Have an account? Sign in"}
      </button>
    </main>
  );
}
