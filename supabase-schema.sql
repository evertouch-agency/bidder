-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor → New query)
-- to create the tables used for persistent settings and the 48h "recently optimized" window.

-- Settings: which ad accounts are selected for optimization
create table if not exists app_settings (
  id text primary key default 'default',
  selected_account_ids jsonb,
  updated_at timestamptz default now()
);
comment on table app_settings is 'App settings; id=default row holds selected_account_ids (array of ad account IDs to show in the optimizer).';

-- 48h window: campaigns that had a bid applied recently (so we don’t re-recommend for 48h)
create table if not exists recently_optimized (
  id uuid primary key default gen_random_uuid(),
  ad_account_id text not null,
  campaign_id text not null,
  applied_at timestamptz not null default now(),
  previous_bid numeric,
  unique(ad_account_id, campaign_id)
);
create index if not exists recently_optimized_ad_account_applied_at
  on recently_optimized (ad_account_id, applied_at desc);
comment on table recently_optimized is 'Campaigns that had a bid applied in the last 48h (per ad account); used to hide them from "optimization available" and show revert.';
