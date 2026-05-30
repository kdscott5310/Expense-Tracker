alter table public.projects
add column if not exists settlement_groups jsonb not null default '[]'::jsonb;
