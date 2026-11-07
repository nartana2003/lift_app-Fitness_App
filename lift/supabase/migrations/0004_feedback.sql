-- In-app feedback (lib/feedback/submit.ts). Each row links a user to the
-- GitHub issue their message became, so Profile can show Open / Fixed / Closed.
-- Server-only: not in Dexie or the outbox.
create table public.feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  issue_number int not null,
  message text not null,
  created_at timestamptz not null default now()
);
create index feedback_user_created_idx on public.feedback (user_id, created_at desc);

alter table public.feedback enable row level security;
create policy "own rows" on public.feedback for all using (user_id = auth.uid()) with check (user_id = auth.uid());
