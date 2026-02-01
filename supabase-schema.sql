-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor → New query)
-- to create the tables used for persistent settings and the 48h "recently optimized" window.
-- If you already have a users table with ad_account_id, run: ALTER TABLE users DROP COLUMN IF EXISTS ad_account_id;

-- Multi-user: one row per LinkedIn user (when JWT + Supabase are configured)
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  linkedin_user_id text not null unique,
  access_token text not null,
  updated_at timestamptz default now()
);
comment on table users is 'One row per Bidder user; JWT cookie stores id; access_token used for LinkedIn API. Current ad account is chosen in-app (not stored).';

-- Settings: which ad accounts are selected for optimization (one row per user; id = user_id as text)
create table if not exists app_settings (
  id text primary key,
  user_id uuid references users(id) on delete cascade not null,
  selected_account_ids jsonb,
  updated_at timestamptz default now(),
  unique(user_id)
);
comment on table app_settings is 'App settings; one row per user. selected_account_ids = array of ad account IDs.';

-- 48h window: campaigns that had a bid applied recently (so we don't re-recommend for 48h)
create table if not exists recently_optimized (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  ad_account_id text not null,
  campaign_id text not null,
  applied_at timestamptz not null default now(),
  previous_bid numeric,
  unique(ad_account_id, campaign_id)
);
create index if not exists recently_optimized_ad_account_applied_at
  on recently_optimized (ad_account_id, applied_at desc);
create index if not exists recently_optimized_user_id on recently_optimized (user_id);
comment on table recently_optimized is 'Campaigns that had a bid applied in the last 48h (per ad account, per user).';
