-- Run this once in the Supabase SQL editor to add account-owned trips.
-- It only adds metadata columns; existing projects, receipts, and items stay intact.

alter table public.projects
add column if not exists owner_id uuid references auth.users(id) on delete set null;

alter table public.projects
add column if not exists trip_code text;

create unique index if not exists projects_trip_code_unique
on public.projects (trip_code)
where trip_code is not null and trip_code <> '';

create index if not exists projects_owner_id_idx
on public.projects (owner_id);

-- Owner-based authenticated policies for account trips.
-- Existing anon shared-link policies can remain in place for public collaboration links.
drop policy if exists "owners can manage their projects" on public.projects;
create policy "owners can manage their projects" on public.projects
for all to authenticated
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

drop policy if exists "owners can manage their project members" on public.project_members;
create policy "owners can manage their project members" on public.project_members
for all to authenticated
using (
  exists (
    select 1 from public.projects
    where projects.id = project_members.project_id
    and projects.owner_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.projects
    where projects.id = project_members.project_id
    and projects.owner_id = auth.uid()
  )
);

drop policy if exists "owners can manage their receipts" on public.receipts;
create policy "owners can manage their receipts" on public.receipts
for all to authenticated
using (
  exists (
    select 1 from public.projects
    where projects.id = receipts.project_id
    and projects.owner_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.projects
    where projects.id = receipts.project_id
    and projects.owner_id = auth.uid()
  )
);

drop policy if exists "owners can manage their receipt items" on public.receipt_items;
create policy "owners can manage their receipt items" on public.receipt_items
for all to authenticated
using (
  exists (
    select 1 from public.receipts
    join public.projects on projects.id = receipts.project_id
    where receipts.id = receipt_items.receipt_id
    and projects.owner_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.receipts
    join public.projects on projects.id = receipts.project_id
    where receipts.id = receipt_items.receipt_id
    and projects.owner_id = auth.uid()
  )
);
