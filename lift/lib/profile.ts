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

/** Local copy first (works offline); falls back to the cloud copy on a fresh device. */
export async function loadProfile(): Promise<Profile> {
  const local = (await db.meta.get(KEY))?.value as Profile | undefined;
  if (local) return { ...emptyProfile(), ...local };
  if (!supabaseConfigured || !navigator.onLine) return emptyProfile();
  try {
    const supabase = supabaseBrowser();
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return emptyProfile();
    const { data } = await supabase
      .from("profiles")
      .select("display_name, email, phone, gender, birth_date")
      .eq("id", auth.user.id)
      .maybeSingle();
    const p: Profile = {
      name: data?.display_name ?? "",
      email: data?.email ?? auth.user.email ?? "",
      phone: data?.phone ?? "",
      gender: (data?.gender as Gender | null) ?? "",
      birth_date: data?.birth_date ?? "",
    };
    await db.meta.put({ key: KEY, value: p });
    return p;
  } catch {
    return emptyProfile();
  }
}

/** Saves locally, then pushes to the cloud when possible. Returns true if the cloud copy is up to date. */
export async function saveProfile(p: Profile): Promise<boolean> {
  await db.meta.put({ key: KEY, value: p });
  if (!supabaseConfigured || !navigator.onLine) return false;
  try {
    const supabase = supabaseBrowser();
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return false;
    const { error } = await supabase.from("profiles").upsert({
      id: auth.user.id,
      display_name: p.name || null,
      email: p.email || null,
      phone: p.phone || null,
      gender: p.gender || null,
      birth_date: p.birth_date || null,
    });
    return !error;
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
