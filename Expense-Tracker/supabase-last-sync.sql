-- Run this once in Supabase to display the latest successful server sync.
-- It is additive and does not change existing trip, receipt, or expense data.

alter table public.projects
add column if not exists last_synced_at timestamptz;

update public.projects
set last_synced_at = coalesce(last_synced_at, created_at, now())
where last_synced_at is null;

create index if not exists projects_last_synced_at_idx
on public.projects (last_synced_at desc);
