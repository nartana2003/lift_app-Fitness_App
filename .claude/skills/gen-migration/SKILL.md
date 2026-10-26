---
name: gen-migration
description: Add a new Supabase table or column to Lift and keep the Dexie store, outbox sync and tests in step. Use for any schema change.
disable-model-invocation: true
---

# Add a schema change

Lift stores data twice: Dexie (source of truth) and Supabase (synced copy). A change must land in both, or sync breaks. Argument: what to add, for example `body_fat column on measurements`.

## Steps
1. Read `lift/supabase/migrations/` and `lift/lib/offline/db.ts` first. Never edit an existing migration (a hook blocks it).
2. Create `lift/supabase/migrations/NNNN_<name>.sql`, next number after the highest. Follow `0001_init.sql`:
   - New table: `id uuid primary key default gen_random_uuid()`, `user_id uuid not null references auth.users(id) on delete cascade default auth.uid()`, `updated_at timestamptz not null default now()`, plus an index on `(user_id, ...)`.
   - Enable RLS and add the `own rows` policy: `for all using (user_id = auth.uid()) with check (user_id = auth.uid())`. Do not rely on the loop in 0001; it only covers tables that existed then.
   - New column on an existing table: `alter table ... add column if not exists`, nullable or with a default, so older clients keep working.
3. Dexie, in `lift/lib/offline/db.ts`:
   - Add the row type and a `Table` on `LiftDB`.
   - New table or new indexed field: add `this.version(N+1).stores({...})` with only the changed stores. Unindexed fields need no version bump (see the `RoutineRow` comment).
   - New synced table: add its name to the `SyncTable` union.
4. Sync, in `lift/lib/offline/sync.ts`: writes go through `enqueue` with client-generated UUIDs (`uuid()`). If the table should come down on a new device, extend `pull`. Never overwrite while the outbox is non-empty.
5. Tests: add or extend `lift/lib/offline/__tests__/sync.test.ts` (fake-indexeddb). Cover enqueue, a failed flush that keeps the item, and idempotent re-send.
6. Run from `lift/`: `npx tsc --noEmit`, `npm run lint`, `npm test`. Then run the `offline-sync-reviewer` agent.

## Rules
- The app must keep working with no Supabase configured.
- No emojis, in code or SQL comments.
