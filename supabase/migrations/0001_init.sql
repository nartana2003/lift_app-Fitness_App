-- Lift: initial schema
-- Run in Supabase SQL editor (or `supabase db push`).

create extension if not exists "pgcrypto";

-- ---------- Profiles ----------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  height_cm numeric,
  birth_date date,
  gender text check (gender in ('male','female','other','prefer_not')),
  phone text,
  email text,
  unit_pref text not null default 'kg' check (unit_pref in ('kg','lb')),
  weekly_goal_sessions int not null default 3,
  reminder_days int[] not null default '{}',          -- 0=Sun..6=Sat
  reminder_time time,
  timezone text not null default 'UTC',
  default_rest_sec int not null default 90,
  created_at timestamptz not null default now()
);

-- auto-create profile on signup
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Exercise catalogue (shared, seeded) ----------
create table public.exercises (
  id text primary key,                       -- free-exercise-db id
  name text not null,
  muscle_groups text[] not null default '{}',     -- app groups (primary)
  secondary_groups text[] not null default '{}',
  equipment text not null default 'Other',        -- Machine/Cable, Dumbbell, Barbell, Bodyweight, Bands, Kettlebell, Other
  category text,
  mechanic text,
  force text,
  level text,
  instructions text[] not null default '{}',
  image_urls text[] not null default '{}',
  tiktok_url text not null,
  owner_id uuid references auth.users(id) on delete cascade,   -- null = catalogue; else user's custom exercise
  video_url text                                               -- e.g. the TikTok/IG/YouTube it came from
);
create index exercises_groups_idx on public.exercises using gin (muscle_groups);

-- ---------- Workouts ----------
create table public.workouts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  duration_sec int generated always as (
    case when ended_at is null then null
         else extract(epoch from (ended_at - started_at))::int end) stored,
  notes text,
  routine_id uuid,
  updated_at timestamptz not null default now()
);
create index workouts_user_started_idx on public.workouts (user_id, started_at desc);

create table public.workout_exercises (
  id uuid primary key default gen_random_uuid(),
  workout_id uuid not null references public.workouts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  exercise_id text not null references public.exercises(id),
  position int not null default 0
);
create index workout_exercises_workout_idx on public.workout_exercises (workout_id);
create index workout_exercises_user_ex_idx on public.workout_exercises (user_id, exercise_id);

create table public.sets (
  id uuid primary key default gen_random_uuid(),
  workout_exercise_id uuid not null references public.workout_exercises(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  set_no int not null,
  reps int not null default 0,
  weight numeric not null default 0,
  is_warmup boolean not null default false,
  rir smallint check (rir between 0 and 3),          -- 0=failure,1=hard,2=good,3=easy+
  completed_at timestamptz not null default now()
);
create index sets_we_idx on public.sets (workout_exercise_id);

-- ---------- Routines / splits ----------
create table public.routines (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  name text not null,
  day_label text,
  source text not null default 'manual' check (source in ('manual','ai','social')),
  kind text not null default 'routine' check (kind in ('routine','mini')),
  source_url text,
  platform text check (platform in ('tiktok','instagram','youtube')),
  thumbnail_url text,
  creator text,
  notes text,
  created_at timestamptz not null default now()
);
alter table public.workouts
  add constraint workouts_routine_fk foreign key (routine_id) references public.routines(id) on delete set null;

create table public.routine_exercises (
  id uuid primary key default gen_random_uuid(),
  routine_id uuid not null references public.routines(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  exercise_id text not null references public.exercises(id),
  position int not null default 0,
  target_sets int not null default 3,
  target_reps text not null default '8-12',   -- '8-12', '10', or '45s' for timed
  rest_sec int
);

create table public.splits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  name text not null,
  days jsonb not null default '[]',      -- [{day:"Push", muscles:["Chest","Shoulders","Triceps"]}]
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.planned_days (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  date date not null,
  routine_id uuid references public.routines(id) on delete set null,
  status text not null default 'planned' check (status in ('planned','done','skipped','moved')),
  workout_id uuid references public.workouts(id) on delete set null,
  skip_reason text check (skip_reason in ('busy','tired','sore','sick','injury','travel','rest','other')),
  skip_note text,
  moved_to_id uuid references public.planned_days(id) on delete set null,
  moved_from_id uuid references public.planned_days(id) on delete set null,
  created_at timestamptz not null default now()
);
create index planned_days_user_date_idx on public.planned_days (user_id, date);

-- ---------- Body / goals ----------
-- Body weight, body fat, calories, neck/chest/waist/… (cm), height, fat-free mass.
create table public.measurements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  type text not null,
  value numeric not null,
  date date not null default current_date
);
create index measurements_user_type_date_idx on public.measurements (user_id, type, date desc);

create table public.goals (
  user_id uuid primary key references auth.users(id) on delete cascade default auth.uid(),
  goal_type text not null default 'build_muscle'
    check (goal_type in ('build_muscle','strength','general','fat_loss')),
  experience_level text not null default 'intermediate'
    check (experience_level in ('beginner','intermediate','advanced')),
  sessions_per_week int not null default 3,
  focus_muscles text[] not null default '{}',
  goal_text text,
  updated_at timestamptz not null default now()
);

create table public.muscle_targets (
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  muscle_group text not null,
  weekly_sets int not null,
  reason text,
  source text not null default 'manual' check (source in ('ai','manual','default')),
  updated_at timestamptz not null default now(),
  primary key (user_id, muscle_group)
);

-- ---------- Per-exercise settings, equipment, PRs, plateaus ----------
create table public.user_exercise_settings (
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  exercise_id text not null references public.exercises(id),
  rest_sec int,
  notes text,
  primary key (user_id, exercise_id)
);

create table public.user_equipment (
  user_id uuid primary key references auth.users(id) on delete cascade default auth.uid(),
  equipment text[] not null default '{Machine/Cable,Dumbbell,Barbell,Bodyweight,Bands,Kettlebell}'
);

create table public.personal_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  exercise_id text not null references public.exercises(id),
  type text not null check (type in ('weight','reps','e1rm','volume')),
  value numeric not null,
  reps int,
  weight numeric,
  set_id uuid references public.sets(id) on delete set null,
  achieved_at timestamptz not null default now()
);
create index prs_user_ex_idx on public.personal_records (user_id, exercise_id, type, achieved_at desc);

create table public.plateaus (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  exercise_id text not null references public.exercises(id),
  weeks_stalled int not null,
  suggestion text,
  status text not null default 'open' check (status in ('open','applied','dismissed')),
  created_at timestamptz not null default now()
);

-- ---------- Notifications ----------
create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  endpoint text not null unique,
  keys jsonb not null,
  created_at timestamptz not null default now()
);

create table public.reminder_snoozes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  until timestamptz not null,
  kind text not null default 'gym'
);

-- ---------- Progress photos ----------
create table public.progress_photos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  workout_id uuid references public.workouts(id) on delete set null,
  taken_at timestamptz not null default now(),
  pose text not null check (pose in ('front','side','back')),
  storage_path text not null
);

create table public.photo_analyses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  month date not null,
  photo_ids uuid[] not null default '{}',
  stats jsonb,
  ai_comment text,
  created_at timestamptz not null default now()
);

insert into storage.buckets (id, name, public)
values ('progress-photos', 'progress-photos', false)
on conflict (id) do nothing;

create policy "own photos read" on storage.objects for select
  using (bucket_id = 'progress-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own photos write" on storage.objects for insert
  with check (bucket_id = 'progress-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own photos delete" on storage.objects for delete
  using (bucket_id = 'progress-photos' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------- Row Level Security ----------
alter table public.exercises enable row level security;
create policy "catalogue + own custom readable" on public.exercises for select
  using (owner_id is null or owner_id = auth.uid());
create policy "own custom insert" on public.exercises for insert with check (owner_id = auth.uid());
create policy "own custom update" on public.exercises for update using (owner_id = auth.uid());
create policy "own custom delete" on public.exercises for delete using (owner_id = auth.uid());

alter table public.profiles enable row level security;
create policy "own profile" on public.profiles for all using (id = auth.uid()) with check (id = auth.uid());

do $$
declare t text;
begin
  foreach t in array array[
    'workouts','workout_exercises','sets','routines','routine_exercises','splits',
    'planned_days','measurements','goals','muscle_targets','user_exercise_settings',
    'user_equipment','personal_records','plateaus','push_subscriptions',
    'reminder_snoozes','progress_photos','photo_analyses'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy "own rows" on public.%I for all using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;

-- ---------- Stats ----------
-- Flat view of working sets with their muscle groups and workout date.
create or replace view public.set_facts with (security_invoker = true) as
select s.id as set_id, s.user_id, w.id as workout_id, w.started_at, we.exercise_id,
       e.muscle_groups, s.reps, s.weight, s.rir, s.is_warmup,
       (s.reps * s.weight) as volume
from public.sets s
join public.workout_exercises we on we.id = s.workout_exercise_id
join public.workouts w on w.id = we.workout_id
join public.exercises e on e.id = we.exercise_id;

-- Summary for a period [p_start, p_end): sessions, duration, volume, sets per muscle group.
create or replace function public.period_stats(p_start timestamptz, p_end timestamptz)
returns jsonb language sql stable security invoker as $$
  select jsonb_build_object(
    'sessions', (select count(*) from public.workouts
                 where user_id = auth.uid() and started_at >= p_start and started_at < p_end),
    'duration_sec', (select coalesce(sum(duration_sec),0) from public.workouts
                 where user_id = auth.uid() and started_at >= p_start and started_at < p_end),
    'volume', (select coalesce(sum(volume),0) from public.set_facts
                 where user_id = auth.uid() and not is_warmup and started_at >= p_start and started_at < p_end),
    'sets_by_muscle', coalesce((
      select jsonb_object_agg(mg, n) from (
        select unnest(muscle_groups) as mg, count(*) as n
        from public.set_facts
        where user_id = auth.uid() and not is_warmup and started_at >= p_start and started_at < p_end
        group by 1) x), '{}'::jsonb),
    'workout_days', coalesce((
      select jsonb_agg(distinct (started_at at time zone 'UTC')::date)
      from public.workouts
      where user_id = auth.uid() and started_at >= p_start and started_at < p_end), '[]'::jsonb)
  );
$$;
