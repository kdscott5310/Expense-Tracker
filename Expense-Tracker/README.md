# Receipt Split

A React + Vite receipt splitting app for shared travel, restaurant, lodging, and ride-share expenses.

## Scripts

- `npm run dev` starts the local Vite server.
- `npm run build` creates the production build in `dist`.
- `npm run lint` checks the app with ESLint.

## Supabase

Copy `.env.example` to `.env` locally and set:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

The app auto-saves the active trip or event in browser storage. **Sync shared project** writes normalized rows to Supabase so the same project link can be opened across devices and by other people.

Sync is intentionally non-destructive: it upserts the current project, receipts, and items without deleting server rows that already exist.

```sql
create table projects (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null,
  settlement_currency text default 'USD',
  exchange_rate numeric default 1
);

create table project_members (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  project_id uuid references projects(id) on delete cascade,
  name text not null
);

create table receipts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  project_id uuid references projects(id) on delete cascade,
  place text,
  merchant text,
  receipt_type text,
  paid_by text,
  base_currency text default 'USD',
  tax_tip numeric default 0,
  ocr_text text
);

create table receipt_items (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  receipt_id uuid references receipts(id) on delete cascade,
  name text not null,
  category text,
  amount numeric default 0,
  shared_by jsonb default '[]'::jsonb
);

alter table projects enable row level security;
alter table project_members enable row level security;
alter table receipts enable row level security;
alter table receipt_items enable row level security;

create policy "public project read" on projects for select to anon using (true);
create policy "public project write" on projects for all to anon using (true) with check (true);

create policy "public member read" on project_members for select to anon using (true);
create policy "public member write" on project_members for all to anon using (true) with check (true);

create policy "public receipt read" on receipts for select to anon using (true);
create policy "public receipt write" on receipts for all to anon using (true) with check (true);

create policy "public item read" on receipt_items for select to anon using (true);
create policy "public item write" on receipt_items for all to anon using (true) with check (true);
```

Add the same environment variables in Vercel project settings before deploying.

For public shared links, turn off Vercel Deployment Protection for the production deployment. Otherwise collaborators may see a Vercel login screen instead of the app.

### Account Trips

To save trips under a logged-in user and load previous trips from the dropdown:

1. Enable Supabase Auth with email/password in the Supabase dashboard.
2. Run `supabase-account-trips.sql` in the Supabase SQL editor.
3. Sign in inside the app.
4. Click **Sync shared project** to save the current trip to your account.
5. Use **Saved trip** > **Load trip** to reopen it later from any device.

The migration only adds `owner_id` and `trip_code` to `projects`; it does not delete or recreate receipt data.

### Trip Expense Metadata

Run `supabase-trip-expense-metadata.sql` to add optional fields for comprehensive trips:

- expense date
- trip stop or city
- activity
- multiple payers on one expense/check

Older expenses still work. If no payment rows are entered, the app uses the single **Paid by** person for the full expense total.

## Gemini Receipt Parsing

Receipt itemization is handled by a Vercel serverless function at `api/parse-receipt.js`.

Set this server-only environment variable locally and in Vercel:

- `GEMINI_API_KEY`

The API route uses Gemini structured JSON output to return merchant, currency, subtotal, tax, tip, total, and item rows. The browser never receives the Gemini key.

## OCR

Receipt image OCR is handled with `tesseract.js` in the browser. PDF and image receipt parsing is handled by Gemini. Upload flow is:

1. Use **AI image/PDF** for Uber PDFs and messy receipt photos.
2. Use **OCR then AI** for clean receipt images when you want lower-cost text parsing.
3. Use **OCR only** when you only want to inspect extracted text.
