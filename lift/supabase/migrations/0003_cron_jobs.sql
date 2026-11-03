-- Lift: storage for the AI-backed cron jobs (CRON-01).
-- Additive only; run after 0001 and 0002. Safe to run twice.
--
-- 1. plateaus.fix / plateaus.source
--    /api/cron/plateaus stores the whole fix (kind, rep range, swap id, extra
--    sets, deload numbers, weeks) next to the one-line suggestion, and whether
--    it came from the model ("ai") or the rules ("rule").
-- 2. photo_analyses.focus / photo_analyses.source
--    /api/cron/photo-analysis stores the focus tips and the comment source;
--    ai_comment holds the comment lines joined by newlines. No image data.
-- 3. target_suggestions
--    /api/cron/target-recheck stores suggested weekly-target changes for the
--    user to approve. One row per user, month and muscle; muscle_targets is
--    never changed by the job.

alter table public.plateaus add column if not exists fix jsonb;
alter table public.plateaus add column if not exists source text check (source in ('ai','rule'));

alter table public.photo_analyses add column if not exists focus jsonb;
alter table public.photo_analyses add column if not exists source text check (source in ('ai','rule'));

create table if not exists public.target_suggestions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  month date not null,
  muscle_group text not null,
  current_sets int not null,
  suggested_sets int not null,
  reason text,
  source text not null default 'rule' check (source in ('ai','rule')),
  status text not null default 'open' check (status in ('open','applied','dismissed')),
  created_at timestamptz not null default now(),
  unique (user_id, month, muscle_group)
);

alter table public.target_suggestions enable row level security;
drop policy if exists "own rows" on public.target_suggestions;
create policy "own rows" on public.target_suggestions for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create index if not exists plateaus_user_status_idx on public.plateaus (user_id, status);
create index if not exists photo_analyses_user_month_idx on public.photo_analyses (user_id, month);
