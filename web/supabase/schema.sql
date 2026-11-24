-- Run once in Supabase SQL Editor. Only the Worker service_role may access these tables.
create table if not exists public.yl_push (
 id text primary key, owner text not null, subscription jsonb not null,
 created_at timestamptz not null default now()
);
create index if not exists yl_push_owner on public.yl_push(owner);
create table if not exists public.yl_calls (
 id text primary key, caller text not null, recipient text not null,
 caller_peer text not null, recipient_peer text not null,
 caller_name text not null, recipient_name text not null,
 kind text not null check(kind in ('audio','video')),
 status text not null check(status in ('ringing','accepted','connected','ended','declined','cancelled','missed')),
 created_at timestamptz not null default now(), expires_at timestamptz not null
);
create index if not exists yl_calls_caller on public.yl_calls(caller,created_at desc);
create index if not exists yl_calls_recipient on public.yl_calls(recipient,created_at desc);
alter table public.yl_push enable row level security;
alter table public.yl_calls enable row level security;
revoke all on public.yl_push, public.yl_calls from anon, authenticated;
-- RLS intentionally has no browser policies. Never expose service_role to the browser.
-- Run weekly via Supabase Cron (free tier limits apply):
-- delete from public.yl_calls where created_at < now() - interval '30 days';

grant all on public.yl_push, public.yl_calls to service_role;
