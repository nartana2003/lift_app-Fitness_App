-- Lift: schema drift fixes and push reminder state (BLK-02).
-- Additive only. 0001_init.sql is left untouched; run this after it
-- (Supabase SQL editor or `supabase db push`). Safe to run twice.
--
-- Why each change exists (the app is the source of truth):
--
-- 1. planned_days.moved_to / moved_from (date)
--    The app (lib/offline/db.ts PlannedDayRow, lib/planner.ts) stores the
--    DATE a day was moved to / from ("YYYY-MM-DD"), in columns named
--    moved_to / moved_from. 0001 created moved_to_id / moved_from_id (uuid
--    references to another row), so every planned_days upsert from the outbox
--    failed with an unknown-column error and blocked the queue.
--    The old *_id columns are kept (never dropped) so nothing that reads them
--    breaks; the app does not write them.
--
-- 2. planned_days.was_marked (boolean)
--    Set on a move's destination when that date was already a routine-less
--    gym day, so undoing the move restores the mark. The client always sends
--    an explicit true/false (lib/offline/remote.ts).
--
-- 3. routines.split_day_id (text)
--    The split day (SplitDay.id, a client string id, not a uuid) a routine
--    belongs to. Null = unassigned.
--
-- 4. progress_photos.pose nullable
--    Gallery photos can be saved without a pose (PhotoRow.pose is
--    "front" | "side" | "back" | null). The check constraint still limits
--    non-null values. progress_photos.workout_id (photo linked to a workout
--    from the Finish screen) already exists in 0001 and is used as is.
--
-- 5. storage update policy for progress-photos
--    Uploads use upsert (a replaced Finish-screen photo keeps its id and
--    path), which needs an UPDATE policy on storage.objects in addition to
--    the insert/select/delete policies from 0001.
--
-- 6. profiles.reminders (jsonb)
--    The whole reminder settings object from lib/reminders.ts
--    (days, time, behindNudge, smart, snoozeMin, skipDate, snoozedUntil),
--    written by the client when push is on and read by the
--    /api/cron/reminders job. reminder_days / reminder_time / timezone from
--    0001 are also kept in step by the client.
--
-- 7. push_subscriptions(user_id) index for the cron job lookup.

alter table public.planned_days add column if not exists moved_to date;
alter table public.planned_days add column if not exists moved_from date;
alter table public.planned_days add column if not exists was_marked boolean not null default false;

alter table public.routines add column if not exists split_day_id text;

alter table public.progress_photos alter column pose drop not null;

drop policy if exists "own photos update" on storage.objects;
create policy "own photos update" on storage.objects for update
  using (bucket_id = 'progress-photos' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'progress-photos' and (storage.foldername(name))[1] = auth.uid()::text);

alter table public.profiles add column if not exists reminders jsonb;

create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);
create index if not exists progress_photos_user_idx on public.progress_photos (user_id, taken_at desc);
