"use client";

import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "./offline/db";
import { applyRenames, type Exercise } from "./exercises";

type Catalogue = { list: Exercise[]; byId: Map<string, Exercise> };

let cache: Catalogue | null = null;
let pending: Promise<Catalogue> | null = null;

/** The built-in catalogue (fetched once; cached by the service worker for offline use). */
export function loadCatalogue(): Promise<Catalogue> {
  if (cache) return Promise.resolve(cache);
  pending ??= fetch("/exercises.json")
    .then((r) => r.json() as Promise<Exercise[]>)
    .then((list) => (cache = { list, byId: new Map(list.map((e) => [e.id, e])) }));
  return pending;
}

/** Built-in catalogue plus the user's own custom exercises. */
export function useCatalogue() {
  const [base, setBase] = useState<Catalogue | null>(cache);
  const custom = useLiveQuery(() => db.custom_exercises.toArray(), []);
  const renames = useLiveQuery(async () => ((await db.meta.get("renames"))?.value as Record<string, string> | undefined) ?? {}, []);
  useEffect(() => {
    if (!base) loadCatalogue().then(setBase);
  }, [base]);

  return useMemo(() => {
    const all = applyRenames([...((custom ?? []) as unknown as Exercise[]), ...(base?.list ?? [])], renames ?? {});
    const byId = new Map<string, Exercise>(all.map((e) => [e.id, e]));
    return {
      loading: !base,
      exercises: all,
      get: (id: string) => byId.get(id),
    };
  }, [base, custom, renames]);
}
