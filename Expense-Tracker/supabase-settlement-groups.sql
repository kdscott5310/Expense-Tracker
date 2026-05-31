alter table public.projects
add column if not exists settlement_groups jsonb not null default '[]'::jsonb;

alter table public.projects
add column if not exists settlement_payments jsonb not null default '[]'::jsonb;

alter table public.projects
add column if not exists discrepancies jsonb not null default '[]'::jsonb;
