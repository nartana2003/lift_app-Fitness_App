"use client";

import { db } from "./offline/db";
import { supabaseBrowser } from "./supabase/client";
import { supabaseConfigured } from "./supabase/configured";

export type Gender = "male" | "female" | "other" | "prefer_not";

export type Profile = {
  name: string;
  email: string;
  phone: string;
  gender: Gender | "";
  birth_date: string; // YYYY-MM-DD or ""
};

export const emptyProfile = (): Profile => ({ name: "", email: "", phone: "", gender: "", birth_date: "" });

const KEY = "profile";

export const PROFILE_FIELDS = ["name", "email", "phone", "gender", "birth_date"] as const satisfies readonly (keyof Profile)[];
type Field = (typeof PROFILE_FIELDS)[number];

/** Profile columns in the `profiles` table. */
const COLUMN: Record<Field, string> = { name: "display_name", email: "email", phone: "phone", gender: "gender", birth_date: "birth_date" };

/** What is stored locally: the profile plus the fields not yet confirmed by the cloud. */
type Stored = Profile & { pending?: Field[] };

/**
 * Where a load came from. `reliable` is false when the cloud copy could not be
 * read (not signed in yet, offline, or an error): the profile shown may then be
 * blank only because the read failed, so it must never be saved over the cloud.
 */
export type ProfileLoadStatus = "local" | "cloud" | "empty" | "not-ready" | "offline" | "error";
export type ProfileLoad = { profile: Profile; status: ProfileLoadStatus; reliable: boolean; pending: Field[] };

/** How long a load waits for the auth session right after a fresh login. */
export const SESSION_WAIT_MS = 3000;

const pick = (v: Stored): Profile => {
  const p = emptyProfile();
  for (const k of PROFILE_FIELDS) if (typeof v[k] === "string") (p as Record<Field, string>)[k] = v[k];
  return p;
};

/** True when nothing but (at most) the email is filled in. */
export const isBlankProfile = (p: Profile) => !p.name && !p.phone && !p.gender && !p.birth_date;

/** Fields whose value differs between two profiles. */
export const changedFields = (base: Profile, next: Profile): Field[] => PROFILE_FIELDS.filter((k) => base[k] !== next[k]);

type Supabase = ReturnType<typeof supabaseBrowser>;
type SessionUser = { id: string; email?: string | null };

/** The signed-in user, waiting up to `ms` for the session to appear after a fresh login. */
export function waitForSessionUser(supabase: Supabase, ms = SESSION_WAIT_MS): Promise<SessionUser | null> {
  return new Promise((resolve) => {
    let done = false;
    // Declared before use: the auth callback can fire before the assignment below.
    // eslint-disable-next-line prefer-const
    let sub: { unsubscribe(): void } | undefined;
    const finish = (u: SessionUser | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sub?.unsubscribe();
      resolve(u);
    };
    const timer = setTimeout(() => finish(null), ms);
    sub = supabase.auth.onAuthStateChange((_event: string, session: { user?: SessionUser } | null) => {
      if (session?.user) finish(session.user);
    }).data.subscription;
    if (done) sub?.unsubscribe();
    supabase.auth.getSession().then(
      ({ data }: { data: { session: { user?: SessionUser } | null } }) => {
        if (data.session?.user) finish(data.session.user);
      },
      () => finish(null),
    );
  });
}

/**
 * Loads the profile and says whether the read can be trusted. The local copy
 * wins (works offline) unless it is blank, which an earlier failed load may
 * have left behind; then the cloud copy is read, after waiting for the session.
 */
export async function loadProfileStatus(sessionWaitMs = SESSION_WAIT_MS): Promise<ProfileLoad> {
  const stored = (await db.meta.get(KEY))?.value as Stored | undefined;
  const pending = stored?.pending?.filter((k) => (PROFILE_FIELDS as readonly string[]).includes(k)) ?? [];
  const local = stored ? pick(stored) : undefined;
  if (local && (!isBlankProfile(local) || pending.length)) return { profile: local, status: "local", reliable: true, pending };
  const fallback = local ?? emptyProfile();
  if (!supabaseConfigured) return { profile: fallback, status: "empty", reliable: true, pending };
  if (!navigator.onLine) return { profile: fallback, status: "offline", reliable: false, pending };
  try {
    const supabase = supabaseBrowser();
    const user = await waitForSessionUser(supabase, sessionWaitMs);
    if (!user) return { profile: fallback, status: "not-ready", reliable: false, pending };
    const { data, error } = await supabase
      .from("profiles")
      .select("display_name, email, phone, gender, birth_date")
      .eq("id", user.id)
      .maybeSingle();
    if (error) return { profile: fallback, status: "error", reliable: false, pending };
    const p: Profile = {
      name: data?.display_name ?? "",
      email: data?.email ?? user.email ?? fallback.email,
      phone: data?.phone ?? "",
      gender: (data?.gender as Gender | null) ?? "",
      birth_date: data?.birth_date ?? "",
    };
    if (!data) return { profile: p, status: "empty", reliable: true, pending };
    await db.meta.put({ key: KEY, value: p });
    return { profile: p, status: "cloud", reliable: true, pending: [] };
  } catch {
    return { profile: fallback, status: "error", reliable: false, pending };
  }
}

/** Local copy first (works offline); falls back to the cloud copy on a fresh device. */
export async function loadProfile(): Promise<Profile> {
  return (await loadProfileStatus()).profile;
}

/**
 * Saves locally, then pushes to the cloud when possible. Returns true if the cloud copy is up to date.
 * Only fields that changed from `base` (the reliably loaded profile) are sent, plus any left over
 * from an earlier failed push; without `base`, only filled-in fields are sent. A blank field is
 * therefore only written to the cloud when the user cleared it.
 */
export async function saveProfile(p: Profile, base?: Profile): Promise<boolean> {
  const prev = ((await db.meta.get(KEY))?.value as Stored | undefined)?.pending ?? [];
  const changed = base ? changedFields(base, p) : PROFILE_FIELDS.filter((k) => p[k] !== "");
  const send = PROFILE_FIELDS.filter((k) => prev.includes(k) || changed.includes(k));
  if (!supabaseConfigured) {
    await db.meta.put({ key: KEY, value: p });
    return false;
  }
  await db.meta.put({ key: KEY, value: send.length ? { ...p, pending: send } : p });
  if (!send.length) return true;
  if (!navigator.onLine) return false;
  try {
    const supabase = supabaseBrowser();
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return false;
    const row: Record<string, string | null> = { id: auth.user.id };
    for (const k of send) row[COLUMN[k]] = p[k] || null;
    const { error } = await supabase.from("profiles").upsert(row);
    if (error) return false;
    // Only clear the pending list if nothing changed locally while the push was in flight.
    const now = (await db.meta.get(KEY))?.value as Stored | undefined;
    if (now && changedFields(pick(now), p).length === 0) await db.meta.put({ key: KEY, value: p });
    return true;
  } catch {
    return false;
  }
}

export function ageFrom(birth: string, now = new Date()): number | null {
  const d = new Date(birth);
  if (!birth || Number.isNaN(d.getTime())) return null;
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age >= 0 && age < 120 ? age : null;
}
