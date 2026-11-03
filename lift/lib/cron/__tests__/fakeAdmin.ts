import type { SupabaseClient } from "@supabase/supabase-js";

// In-memory stand-in for the service-role Supabase client: only the calls
// the cron stores make (select + in/eq/gte/lt/order + range, insert, upsert,
// storage download). Never talks to a real project.

type Row = Record<string, unknown>;

export function fakeAdmin(tables: Record<string, Row[]>, files: Record<string, Uint8Array> = {}) {
  const inserted: Record<string, Row[]> = {};
  const queries: { table: string; filters: string[] }[] = [];
  const write = (table: string, rows: Row | Row[]) => {
    inserted[table] = [...(inserted[table] ?? []), ...(Array.isArray(rows) ? rows : [rows])];
    return Promise.resolve({ error: null });
  };
  const from = (table: string) => {
    const preds: ((r: Row) => boolean)[] = [];
    const filters: string[] = [];
    queries.push({ table, filters });
    const b = {
      select: () => b,
      in: (c: string, v: unknown[]) => (filters.push(`in:${c}`), preds.push((r) => v.includes(r[c])), b),
      eq: (c: string, v: unknown) => (filters.push(`eq:${c}=${String(v)}`), preds.push((r) => r[c] === v), b),
      gte: (c: string, v: string) => (filters.push(`gte:${c}`), preds.push((r) => String(r[c]) >= v), b),
      lt: (c: string, v: string) => (filters.push(`lt:${c}`), preds.push((r) => String(r[c]) < v), b),
      order: () => b,
      range: (lo: number, hi: number) => Promise.resolve({ data: (tables[table] ?? []).filter((r) => preds.every((p) => p(r))).slice(lo, hi + 1), error: null }),
      insert: (rows: Row | Row[]) => write(table, rows),
      upsert: (rows: Row | Row[]) => write(table, rows),
    };
    return b;
  };
  const storage = {
    from: () => ({
      download: (path: string) =>
        Promise.resolve(files[path] ? { data: new Blob([files[path] as BlobPart]), error: null } : { data: null, error: { message: "not found" } }),
    }),
  };
  return { admin: { from, storage } as unknown as SupabaseClient, inserted, queries };
}
