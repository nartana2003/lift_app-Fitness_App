"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLiveQuery } from "dexie-react-hooks";
import { PageHeader } from "@/components/PageHeader";
import { Collapsible } from "@/components/Collapsible";
import { ReminderSettings } from "@/components/ReminderSettings";
import { reminderSummary, useReminders } from "@/lib/reminders";
import { supabaseBrowser } from "@/lib/supabase/client";
import { supabaseConfigured } from "@/lib/supabase/configured";
import { getRestSec, setRestSec } from "@/lib/workout";
import { fmtClock } from "@/lib/restTimer";
import { ageFrom, changedFields, emptyProfile, loadProfileStatus, saveProfile, type Gender, type Profile } from "@/lib/profile";
import { bmi, bmiLabel, latestMeasurement, saveMeasurement } from "@/lib/measurements";
import { saveSettings, saveTheme, useSettings, useThemePref } from "@/lib/settings";
import { THEME_LABELS, THEME_PREFS } from "@/lib/theme";
import { dispNum, fromDisplay } from "@/lib/units";

const ICONS = {
  person: "M20 21a8 8 0 10-16 0M12 11a4 4 0 100-8 4 4 0 000 8z",
  body: "M12 3.5a1.6 1.6 0 110 3.2 1.6 1.6 0 010-3.2zM7 9h10M9.5 9v4l-1 7.5M14.5 9v4l1 7.5",
  sliders: "M4 7h10M18 7h2M4 17h4M12 17h8",
  dumbbell: "M6.5 6.5v11M17.5 6.5v11M3.5 9v6M20.5 9v6M6.5 12h11",
  split: "M4 6h7M4 12h7M4 18h7M15 6h5M15 12h5M15 18h5",
  target: "M12 21a9 9 0 110-18 9 9 0 010 18zM12 16.5a4.5 4.5 0 110-9 4.5 4.5 0 010 9zM12 13a1 1 0 110-2 1 1 0 010 2z",
  bell: "M6 16V11a6 6 0 1112 0v5l1.5 2h-15L6 16zM10 20.5a2 2 0 004 0",
} as const;

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

const GENDERS: { v: Gender; label: string }[] = [
  { v: "male", label: "Male" },
  { v: "female", label: "Female" },
  { v: "other", label: "Other" },
  { v: "prefer_not", label: "Prefer not to say" },
];

export default function ProfilePage() {
  const router = useRouter();
  const { unit, weekStart } = useSettings();
  const theme = useThemePref();
  const reminders = useReminders();
  const [profile, setProfile] = useState<Profile>(emptyProfile());
  const [height, setHeight] = useState("");
  const [weight, setWeight] = useState("");
  const [rest, setRest] = useState(90);
  const [signedIn, setSignedIn] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  // The profile as last loaded or saved; null until a load could be trusted. Autosave waits for it.
  const baseline = useRef<Profile | null>(null);
  // What an untrusted load put on screen, so edits made meanwhile survive the later trusted load.
  const shown = useRef<Profile>(emptyProfile());
  const [loadFailed, setLoadFailed] = useState(false);

  const latestHeight = useLiveQuery(() => latestMeasurement("height"), []);
  const latestWeight = useLiveQuery(() => latestMeasurement("body_weight"), []);

  const load = useCallback(async () => {
    if (baseline.current) return;
    const r = await loadProfileStatus();
    let p = r.profile;
    if (supabaseConfigured) {
      try {
        const { data } = await supabaseBrowser().auth.getUser();
        setSignedIn(!!data.user);
        p = { ...p, email: p.email || data.user?.email || "" };
      } catch {}
    }
    if (baseline.current) return;
    // Keep anything typed before this load arrived; after a trusted load autosave sends just that.
    const before = shown.current;
    shown.current = p;
    setProfile((cur) => {
      const merged = { ...p };
      for (const k of changedFields(before, cur)) (merged as Record<string, string>)[k] = cur[k];
      return merged;
    });
    if (!r.reliable) {
      // The cloud copy could not be read: show what we have, but never save it over the cloud.
      setLoadFailed(true);
      return;
    }
    baseline.current = p;
    setLoadFailed(false);
    // Fields an earlier save could not push go up now.
    if (r.pending.length) void saveProfile(p, p);
  }, []);

  useEffect(() => {
    void load();
    void getRestSec("").then(setRest);
  }, [load]);

  // A failed or not-ready cloud read is retried once the session appears or the device is back online.
  useEffect(() => {
    if (!loadFailed || !supabaseConfigured) return;
    const retry = () => void load();
    window.addEventListener("online", retry);
    let unsubscribe = () => {};
    try {
      const { data } = supabaseBrowser().auth.onAuthStateChange((_event: string, session: { user?: unknown } | null) => {
        if (session?.user) retry();
      });
      unsubscribe = () => data.subscription.unsubscribe();
    } catch {}
    return () => {
      window.removeEventListener("online", retry);
      unsubscribe();
    };
  }, [loadFailed, load]);

  useEffect(() => {
    if (latestHeight) setHeight(String(latestHeight.value));
    if (latestWeight) setWeight(String(dispNum(latestWeight.value, unit)));
  }, [latestHeight, latestWeight, unit]);

  const set = <K extends keyof Profile>(k: K, v: Profile[K]) => setProfile((p) => ({ ...p, [k]: v }));
  const num = (s: string) => Number(s.replace(",", "."));

  const flash = useCallback((msg: string) => {
    setStatus(msg);
    setTimeout(() => setStatus((cur) => (cur === msg ? null : cur)), 2000);
  }, []);

  // Saves on its own a moment after you stop typing — no Save button. Only after a
  // trusted load, and only when something actually changed.
  useEffect(() => {
    const base = baseline.current;
    if (!base || !changedFields(base, profile).length) return;
    const t = setTimeout(async () => {
      const synced = await saveProfile(profile, base);
      baseline.current = profile;
      flash(supabaseConfigured && !synced ? "Saved on this device" : "Saved");
    }, 700);
    return () => clearTimeout(t);
  }, [profile, flash]);

  /** Height and weight are measurements, so they're saved when you leave the field. */
  async function commitHeight() {
    const v = num(height);
    if (v > 0 && v !== latestHeight?.value) {
      await saveMeasurement("height", v);
      flash("Height saved");
    }
  }

  async function commitWeight() {
    const kg = Math.round(fromDisplay(num(weight), unit) * 100) / 100;
    if (kg > 0 && Math.abs(kg - (latestWeight?.value ?? 0)) > 0.01) {
      await saveMeasurement("body_weight", kg);
      flash("Weight logged");
    }
  }

  const h = num(height);
  const w = fromDisplay(num(weight), unit);
  const b = h > 0 && w > 0 ? bmi(w, h) : 0;
  const age = ageFrom(profile.birth_date);

  const prefSummary = `${unit} · Week starts ${weekStart === 1 ? "Monday" : "Sunday"} · Rest ${fmtClock(rest)} · ${THEME_LABELS[theme]} theme`;
  const bodySummary = [h > 0 ? `${h} cm` : null, num(weight) > 0 ? `${num(weight)} ${unit}` : null, b > 0 ? `BMI ${b}` : null]
    .filter(Boolean)
    .join(" · ");
  const personalSummary = [profile.name, profile.email].filter(Boolean).join(" · ");

  return (
    <>
      <PageHeader
        title="Profile"
        right={<span className={`text-xs text-muted transition-opacity ${status ? "opacity-100" : "opacity-0"}`}>{status ?? ""}</span>}
      />

      <div className="flex items-center gap-3 mb-4">
        <div className="size-14 rounded-full bg-accent text-accent-ink grid place-items-center text-xl font-bold shrink-0">
          {(profile.name.trim()[0] ?? "L").toUpperCase()}
        </div>
        <div className="min-w-0">
          <p className="text-lg font-bold truncate">{profile.name.trim() || "Add your name"}</p>
          <p className="text-xs text-muted truncate">{profile.email || (supabaseConfigured ? "Not signed in" : "Saved on this device")}</p>
        </div>
      </div>

      {(num(weight) > 0 || h > 0 || age !== null) && (
        <div className="grid grid-cols-3 gap-2 text-center mb-4">
          <Stat label="Weight" value={num(weight) > 0 ? `${num(weight)} ${unit}` : "—"} />
          <Stat label="Height" value={h > 0 ? `${h} cm` : "—"} />
          <Stat label={b > 0 ? "BMI" : "Age"} value={b > 0 ? String(b) : age !== null ? `${age}` : "—"} />
        </div>
      )}

      <div className="card mb-2 overflow-hidden">
      <Collapsible grouped title="Personal information" icon={<Icon d={ICONS.person} />} subtitle={personalSummary || "Name, email, phone, gender, date of birth"}>
        {loadFailed && (
          <p className="text-xs text-muted">Your saved profile could not be loaded yet. It loads when you are signed in and online; changes are kept until then.</p>
        )}
        <Field label="Name">
          <input className="field" autoComplete="name" placeholder="Your name" value={profile.name} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field label="Email">
          <input className="field" type="email" autoComplete="email" inputMode="email" placeholder="you@example.com" value={profile.email} onChange={(e) => set("email", e.target.value)} />
        </Field>
        <Field label="Mobile phone">
          <input className="field" type="tel" autoComplete="tel" inputMode="tel" placeholder="+1 555 123 4567" value={profile.phone} onChange={(e) => set("phone", e.target.value)} />
        </Field>
        <Field label="Gender">
          <div className="flex flex-wrap gap-2">
            {GENDERS.map((g) => (
              <button key={g.v} type="button" className={profile.gender === g.v ? "chip-on" : "chip"} onClick={() => set("gender", profile.gender === g.v ? "" : g.v)}>
                {g.label}
              </button>
            ))}
          </div>
        </Field>
        <Field label={`Date of birth${age !== null ? ` · ${age} years old` : ""}`}>
          <input className="field" type="date" max={new Date().toISOString().slice(0, 10)} value={profile.birth_date} onChange={(e) => set("birth_date", e.target.value)} />
        </Field>
      </Collapsible>

      <Collapsible grouped title="Body" icon={<Icon d={ICONS.body} />} subtitle={bodySummary || "Height and weight"}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Height (cm)">
            <input className="field" inputMode="decimal" placeholder="175" value={height} onChange={(e) => setHeight(e.target.value)} onBlur={commitHeight} />
          </Field>
          <Field label={`Weight (${unit})`}>
            <input className="field" inputMode="decimal" placeholder="70" value={weight} onChange={(e) => setWeight(e.target.value)} onBlur={commitWeight} />
          </Field>
        </div>
        {b > 0 && (
          <p className="text-sm">
            BMI <span className="font-semibold">{b}</span> <span className="text-muted">· {bmiLabel(b)}</span>
          </p>
        )}
        <p className="text-xs text-muted">Changing your weight adds an entry to Progress → Measurements, so you can track it over time.</p>
      </Collapsible>

      <Link href="/coach" className="flex items-center gap-3 px-4 py-3.5 text-left border-t border-border">
        <span className="shrink-0 size-9 rounded-xl bg-surface-2 grid place-items-center text-muted">
          <Icon d={ICONS.target} />
        </span>
        <span className="flex-1 min-w-0">
          <span className="block font-semibold text-[15px]">Goals and split are in Coach</span>
          <span className="block text-xs text-muted truncate mt-0.5">Set goals, edit your split and ask the coach</span>
        </span>
        <svg viewBox="0 0 24 24" className="size-5 shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M9 6l6 6-6 6" />
        </svg>
      </Link>

      <Collapsible grouped title="Reminders" icon={<Icon d={ICONS.bell} />} subtitle={reminderSummary(reminders, weekStart)}>
        <ReminderSettings />
      </Collapsible>

      <Collapsible grouped title="Preferences" icon={<Icon d={ICONS.sliders} />} subtitle={prefSummary}>
        <div>
          <span className="font-semibold block mb-2">Weight unit</span>
          <div className="grid grid-cols-2 gap-2">
            {(["kg", "lb"] as const).map((u) => (
              <button key={u} className={unit === u ? "chip-on justify-center py-2" : "chip justify-center py-2"} onClick={() => saveSettings({ unit: u })}>
                {u === "kg" ? "Kilograms (kg)" : "Pounds (lb)"}
              </button>
            ))}
          </div>
        </div>
        <div>
          <span className="font-semibold block mb-2">Week starts on</span>
          <div className="grid grid-cols-2 gap-2">
            {([1, 0] as const).map((d) => (
              <button key={d} className={weekStart === d ? "chip-on justify-center py-2" : "chip justify-center py-2"} onClick={() => saveSettings({ weekStart: d })}>
                {d === 1 ? "Monday" : "Sunday"}
              </button>
            ))}
          </div>
        </div>
        <div>
          <span className="font-semibold block mb-2">Theme</span>
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Theme">
            {THEME_PREFS.map((t) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={theme === t}
                className={theme === t ? "chip-on justify-center py-2" : "chip justify-center py-2"}
                onClick={() => saveTheme(t)}
              >
                {THEME_LABELS[t]}
              </button>
            ))}
          </div>
        </div>
        <label className="flex items-center justify-between gap-3">
          <span>
            <span className="font-semibold block">Default rest timer</span>
            <span className="text-xs text-muted">Used for every exercise unless you change it</span>
          </span>
          <select
            className="field w-auto"
            value={rest}
            onChange={async (e) => {
              const v = Number(e.target.value);
              setRest(v);
              await setRestSec(null, v);
            }}
          >
            {[30, 45, 60, 75, 90, 120, 150, 180, 240, 300].map((s) => (
              <option key={s} value={s}>{fmtClock(s)}</option>
            ))}
          </select>
        </label>
      </Collapsible>
      </div>

      {supabaseConfigured && signedIn && (
        <button
          className="btn-ghost w-full text-bad"
          onClick={async () => {
            await supabaseBrowser().auth.signOut();
            router.replace("/login");
            router.refresh();
          }}
        >
          Sign out
        </button>
      )}
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-2.5">
      <p className="text-[11px] uppercase tracking-wide text-muted">{label}</p>
      <p className="font-semibold">{value}</p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs text-muted mb-1">{label}</span>
      {children}
    </label>
  );
}
