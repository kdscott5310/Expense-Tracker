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

The app writes saved splits to a `receipt_splits` table. A simple table shape is:

```sql
create table receipt_splits (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  receipt_type text,
  paid_by text,
  base_currency text,
  settlement_currency text,
  exchange_rate numeric,
  tax_tip_percent numeric,
  participants jsonb,
  items jsonb,
  calculations jsonb,
  ocr_text text
);
```

Add the same environment variables in Vercel project settings before deploying.

## OCR

Receipt image OCR is handled with `tesseract.js` and loaded lazily when a user uploads an image.
