-- Run this once in Supabase to support trip-day organization and multi-payer checks.
-- It is additive and does not rewrite existing receipt or expense rows.

alter table public.receipts
add column if not exists expense_date date;

alter table public.receipts
add column if not exists trip_stop text default '';

alter table public.receipts
add column if not exists activity text default '';

alter table public.receipts
add column if not exists payments jsonb default '[]'::jsonb;

create index if not exists receipts_project_date_idx
on public.receipts (project_id, expense_date);
