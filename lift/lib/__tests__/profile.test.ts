import "fake-indexeddb/auto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// PROF-01: the profile must survive sign-out and sign-in. loadProfileStatus says
// whether a read can be trusted, and saveProfile only sends the fields that
// changed, so a failed or early read never blanks the cloud row. In-memory fake
// Supabase; no network.

type Row = Record<string, string | null>;
type User = { id: string; email?: string };

const sb = vi.hoisted(() => {
  const state = {
    configured: true,
    session: null as { user: { id: string; email?: string } } | null,
    listeners: new Set<(event: string, session: { user: { id: string; email?: string } } | null) => void>(),
    row: null as Record<string, string | null> | null,
    readError: null as { message: string } | null,
    upsertError: null as { message: string } | null,
    upserts: [] as Record<string, string | null>[],
  };
  const client = {
    auth: {
      getSession: async () => ({ data: { session: state.session } }),
      getUser: async () => ({ data: { user: state.session?.user ?? null } }),
      onAuthStateChange: (cb: (event: string, session: { user: { id: string; email?: string } } | null) => void) => {
        state.listeners.add(cb);
        return { data: { subscription: { unsubscribe: () => state.listeners.delete(cb) } } };
      },
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => (state.readError ? { data: null, error: state.readError } : { data: state.row, error: null }),
        }),
      }),
      // PostgREST upsert merges: columns missing from the payload keep their value.
      upsert: async (row: Record<string, string | null>) => {
        state.upserts.push(row);
        if (state.upsertError) return { error: state.upsertError };
        state.row = { ...(state.row ?? {}), ...row };
        return { error: null };
      },
    }),
  };
  return { state, client };
});

vi.mock("@/lib/supabase/configured", () => ({
  get supabaseConfigured() {
    return sb.state.configured;
  },
}));
vi.mock("../supabase/configured", () => ({
  get supabaseConfigured() {
    return sb.state.configured;
  },
}));
vi.mock("../supabase/client", () => ({ supabaseBrowser: () => sb.client }));

const net = { onLine: true };
vi.stubGlobal("navigator", net);

const { db } = await import("../offline/db");
const { changedFields, emptyProfile, isBlankProfile, loadProfile, loadProfileStatus, saveProfile, waitForSessionUser } = await import("../profile");
type Profile = import("../profile").Profile;

afterAll(() => vi.unstubAllGlobals());

const UID = "11111111-1111-4111-8111-111111111111";
const USER: User = { id: UID, email: "me@example.com" };
const CLOUD: Row = { id: UID, display_name: "Nat", email: "me@example.com", phone: "+1 555 0100", gender: "female", birth_date: "1995-04-02" };
const FULL: Profile = { name: "Nat", email: "me@example.com", phone: "+1 555 0100", gender: "female", birth_date: "1995-04-02" };

const signIn = (u: User = USER) => {
  sb.state.session = { user: u };
  for (const l of [...sb.state.listeners]) l("SIGNED_IN", sb.state.session);
};
const signOut = () => {
  sb.state.session = null;
};
const local = async () => (await db.meta.get("profile"))?.value as (Profile & { pending?: string[] }) | undefined;

beforeEach(async () => {
  await db.meta.clear();
  Object.assign(sb.state, { configured: true, session: null, row: null, readError: null, upsertError: null, upserts: [] });
  sb.state.listeners.clear();
  net.onLine = true;
});

describe("loadProfileStatus", () => {
  it("fresh login: waits for the session, then restores every field from the cloud", async () => {
    sb.state.row = { ...CLOUD };
    const pending = loadProfileStatus(1000);
    setTimeout(() => signIn(), 20);
    const r = await pending;
    expect(r).toMatchObject({ status: "cloud", reliable: true, profile: FULL });
    expect(await local()).toEqual(FULL);
    expect(sb.state.listeners.size).toBe(0);
  });

  it("session not ready: unreliable, nothing cached, nothing written", async () => {
    sb.state.row = { ...CLOUD };
    const r = await loadProfileStatus(30);
    expect(r).toMatchObject({ status: "not-ready", reliable: false, profile: emptyProfile() });
    expect(await local()).toBeUndefined();
    expect(sb.state.upserts).toEqual([]);
    expect(sb.state.listeners.size).toBe(0);
  });

  it("cloud read error: unreliable, cloud row and local store untouched, a later load succeeds", async () => {
    sb.state.row = { ...CLOUD };
    sb.state.readError = { message: "boom" };
    signIn();
    const r = await loadProfileStatus(30);
    expect(r).toMatchObject({ status: "error", reliable: false });
    expect(await local()).toBeUndefined();
    expect(sb.state.row).toEqual(CLOUD);

    sb.state.readError = null;
    expect(await loadProfileStatus(30)).toMatchObject({ status: "cloud", reliable: true, profile: FULL });
  });

  it("empty cloud row: reliable and blank, with the session email", async () => {
    signIn();
    const r = await loadProfileStatus(30);
    expect(r).toMatchObject({ status: "empty", reliable: true, profile: { ...emptyProfile(), email: "me@example.com" } });
  });

  it("offline with no local copy: unreliable", async () => {
    net.onLine = false;
    expect(await loadProfileStatus(30)).toMatchObject({ status: "offline", reliable: false });
  });

  it("a filled-in local copy wins (offline first)", async () => {
    await db.meta.put({ key: "profile", value: { ...FULL, name: "Local" } });
    net.onLine = false;
    expect(await loadProfileStatus(30)).toMatchObject({ status: "local", reliable: true, profile: { ...FULL, name: "Local" } });
  });

  it("a blank local copy (left by an earlier failed load) does not hide the cloud copy", async () => {
    await db.meta.put({ key: "profile", value: { ...emptyProfile(), email: "me@example.com" } });
    sb.state.row = { ...CLOUD };
    signIn();
    expect(await loadProfileStatus(30)).toMatchObject({ status: "cloud", profile: FULL });
  });

  it("local only (no Supabase): reliable, empty", async () => {
    sb.state.configured = false;
    expect(await loadProfileStatus(30)).toMatchObject({ status: "empty", reliable: true, profile: emptyProfile() });
  });

  it("loadProfile still returns the plain profile", async () => {
    sb.state.row = { ...CLOUD };
    signIn();
    expect(await loadProfile()).toEqual(FULL);
  });
});

describe("saveProfile", () => {
  it("sends only the fields that changed from the loaded profile", async () => {
    sb.state.row = { ...CLOUD };
    signIn();
    const { profile } = await loadProfileStatus(30);
    expect(await saveProfile({ ...profile, phone: "+1 555 0199" }, profile)).toBe(true);
    expect(sb.state.upserts).toEqual([{ id: UID, phone: "+1 555 0199" }]);
    expect(sb.state.row).toEqual({ ...CLOUD, phone: "+1 555 0199" });
    expect((await local())?.pending).toBeUndefined();
  });

  it("without a base, never sends blank fields over the cloud row", async () => {
    sb.state.row = { ...CLOUD };
    signIn();
    expect(await saveProfile({ ...emptyProfile(), email: "me@example.com" })).toBe(true);
    expect(sb.state.upserts).toEqual([{ id: UID, email: "me@example.com" }]);
    expect(sb.state.row).toEqual(CLOUD);
  });

  it("a blank profile with no base sends nothing", async () => {
    sb.state.row = { ...CLOUD };
    signIn();
    await saveProfile(emptyProfile());
    expect(sb.state.upserts).toEqual([]);
    expect(sb.state.row).toEqual(CLOUD);
  });

  it("a field the user cleared is cleared in the cloud", async () => {
    sb.state.row = { ...CLOUD };
    signIn();
    const { profile } = await loadProfileStatus(30);
    await saveProfile({ ...profile, phone: "" }, profile);
    expect(sb.state.upserts).toEqual([{ id: UID, phone: null }]);
  });

  it("a push that fails keeps the field pending and sends it on the next save", async () => {
    sb.state.row = { ...CLOUD };
    signIn();
    const { profile } = await loadProfileStatus(30);
    net.onLine = false;
    const edited = { ...profile, name: "Natalie" };
    expect(await saveProfile(edited, profile)).toBe(false);
    expect((await local())?.pending).toEqual(["name"]);

    net.onLine = true;
    const again = await loadProfileStatus(30);
    expect(again).toMatchObject({ status: "local", pending: ["name"], profile: edited });
    expect(await saveProfile(again.profile, again.profile)).toBe(true);
    expect(sb.state.upserts).toEqual([{ id: UID, display_name: "Natalie" }]);
    expect((await local())?.pending).toBeUndefined();
  });

  it("an upsert error keeps the field pending", async () => {
    signIn();
    sb.state.upsertError = { message: "rls" };
    const base = { ...emptyProfile(), email: "me@example.com" };
    expect(await saveProfile({ ...base, name: "Nat" }, base)).toBe(false);
    expect((await local())?.pending).toEqual(["name"]);
  });

  it("local only (no Supabase): saves on the device and returns false", async () => {
    sb.state.configured = false;
    expect(await saveProfile(FULL)).toBe(false);
    expect(await local()).toEqual(FULL);
    expect(sb.state.upserts).toEqual([]);
  });
});

describe("edit, sign out, sign in on the same device", () => {
  it("restores name, phone, gender and birth date", async () => {
    signIn();
    const first = await loadProfileStatus(30);
    expect(first.status).toBe("empty");
    await saveProfile(FULL, first.profile);
    expect(sb.state.row).toMatchObject({ display_name: "Nat", phone: "+1 555 0100", gender: "female", birth_date: "1995-04-02" });

    signOut();
    // Signed out: the profile page is not reachable, but an early load must not blank anything.
    await loadProfileStatus(30);
    expect(sb.state.row).toMatchObject({ display_name: "Nat" });

    const again = loadProfileStatus(1000);
    setTimeout(() => signIn(), 20);
    expect(await again).toMatchObject({ reliable: true, profile: FULL });
  });

  it("restores from the cloud when the local copy is gone (account takeover, cleared storage)", async () => {
    sb.state.row = { ...CLOUD };
    signIn();
    const loaded = await loadProfileStatus(30);
    await saveProfile({ ...loaded.profile, gender: "other" }, loaded.profile);
    signOut();
    await db.meta.delete("profile");

    const again = loadProfileStatus(1000);
    setTimeout(() => signIn(), 20);
    expect(await again).toMatchObject({ status: "cloud", profile: { ...FULL, gender: "other" } });
  });

  it("a session that never arrives leaves the cloud row as it was", async () => {
    sb.state.row = { ...CLOUD };
    const r = await loadProfileStatus(30);
    expect(r.reliable).toBe(false);
    // The page does not autosave after an unreliable load; even a plain save of what it showed sends nothing.
    await saveProfile(r.profile);
    expect(sb.state.upserts).toEqual([]);
    expect(sb.state.row).toEqual(CLOUD);
  });
});

describe("helpers", () => {
  it("changedFields lists differing fields in a fixed order", () => {
    expect(changedFields(FULL, { ...FULL, birth_date: "", name: "X" })).toEqual(["name", "birth_date"]);
    expect(changedFields(FULL, { ...FULL })).toEqual([]);
  });

  it("isBlankProfile ignores the email", () => {
    expect(isBlankProfile({ ...emptyProfile(), email: "a@b.c" })).toBe(true);
    expect(isBlankProfile({ ...emptyProfile(), gender: "male" })).toBe(false);
  });

  it("waitForSessionUser resolves an existing session at once and times out to null", async () => {
    signIn();
    expect(await waitForSessionUser(sb.client as never, 30)).toEqual(USER);
    signOut();
    expect(await waitForSessionUser(sb.client as never, 20)).toBeNull();
    expect(sb.state.listeners.size).toBe(0);
  });

  it("waitForSessionUser picks up a sign-in that arrives later", async () => {
    const p = waitForSessionUser(sb.client as never, 1000);
    setTimeout(() => signIn(), 10);
    expect(await p).toEqual(USER);
  });
});

