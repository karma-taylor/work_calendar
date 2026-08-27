-- Security hardening for the single-workspace Work Calendar deployment.
-- Apply after 202608230001_work_calendar_security.sql.

alter table public.work_calendar_members
  add column if not exists user_id uuid unique,
  add column if not exists role text not null default 'roster_admin',
  add column if not exists is_active boolean not null default true,
  add column if not exists revoked_at timestamptz;
alter table public.work_calendar_members
  drop constraint if exists work_calendar_members_role_check;
alter table public.work_calendar_members
  add constraint work_calendar_members_role_check check (role in ('viewer', 'scheduler', 'roster_admin'));

create table if not exists public.work_calendar_api_keys (
  key_id text primary key check (key_id ~ '^[a-z0-9][a-z0-9_-]{2,63}$'),
  key_hash text not null unique,
  role text not null check (role in ('viewer', 'scheduler', 'roster_admin')),
  is_active boolean not null default true,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
alter table public.work_calendar_api_keys enable row level security;

alter table public.work_calendar_events
  add column if not exists actor_user_id uuid,
  add column if not exists actor_key_id text,
  add column if not exists actor_role text,
  add column if not exists request_id uuid,
  add column if not exists change_summary jsonb not null default '{}'::jsonb;
create index if not exists idx_work_calendar_events_request_id on public.work_calendar_events (request_id);

create table if not exists public.work_calendar_login_rate_limits (
  bucket text primary key,
  window_started_at timestamptz not null,
  attempts integer not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.work_calendar_login_rate_limits enable row level security;

create or replace function public.consume_work_calendar_login_rate(
  p_bucket text,
  p_max_attempts integer default 5,
  p_window interval default interval '1 hour'
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_current public.work_calendar_login_rate_limits%rowtype;
begin
  select * into v_current from public.work_calendar_login_rate_limits where bucket = p_bucket for update;
  if not found or v_current.window_started_at <= now() - p_window then
    insert into public.work_calendar_login_rate_limits(bucket, window_started_at, attempts, updated_at)
    values (p_bucket, now(), 1, now())
    on conflict (bucket) do update set window_started_at = excluded.window_started_at, attempts = 1, updated_at = excluded.updated_at;
    return true;
  end if;
  if v_current.attempts >= p_max_attempts then return false; end if;
  update public.work_calendar_login_rate_limits set attempts = attempts + 1, updated_at = now() where bucket = p_bucket;
  return true;
end; $$;
revoke all on function public.consume_work_calendar_login_rate(text, integer, interval) from public;
grant execute on function public.consume_work_calendar_login_rate(text, integer, interval) to service_role;

create or replace function public.purge_work_calendar_retention(
  p_event_retention interval default interval '90 days',
  p_history_retention interval default interval '365 days'
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_events integer; v_history integer; v_rates integer;
begin
  delete from public.work_calendar_events where created_at < now() - p_event_retention;
  get diagnostics v_events = row_count;
  delete from public.app_state_history where created_at < now() - p_history_retention;
  get diagnostics v_history = row_count;
  delete from public.work_calendar_login_rate_limits where updated_at < now() - interval '2 days';
  get diagnostics v_rates = row_count;
  return jsonb_build_object('events', v_events, 'history', v_history, 'rate_limits', v_rates);
end; $$;
revoke all on function public.purge_work_calendar_retention(interval, interval) from public;
grant execute on function public.purge_work_calendar_retention(interval, interval) to service_role;

-- RLS remains enabled for all application tables. The Edge Function connects
-- with the service_role and therefore also needs SQL object privileges; RLS
-- alone does not grant those privileges on a newly-created project.
grant usage on schema public to service_role;
grant select, insert, update on table public.app_state to service_role;
grant select, insert on table public.app_state_history to service_role;
grant select, insert, update on table public.work_calendar_members to service_role;
grant select, insert, update on table public.work_calendar_api_keys to service_role;
grant select, insert on table public.work_calendar_events to service_role;
grant select, insert, update, delete on table public.work_calendar_login_rate_limits to service_role;
grant usage, select on sequence public.app_state_history_id_seq to service_role;
grant usage, select on sequence public.work_calendar_events_id_seq to service_role;
