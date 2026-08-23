-- Secure state access for the Work Calendar web app and Codex Skill.
-- This migration is self-contained and may be applied to a new, empty project.
create table if not exists public.app_state (
  id text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.app_state_history (
  id bigint generated always as identity primary key,
  state_id text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_app_state_history_state_created on public.app_state_history (state_id, created_at desc);
alter table public.app_state enable row level security;
alter table public.app_state_history enable row level security;

create table if not exists public.work_calendar_members (
  email text primary key,
  created_at timestamptz not null default now()
);

create table if not exists public.work_calendar_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  actor_channel text not null check (actor_channel in ('web', 'skill', 'system')),
  operation text not null,
  success boolean not null,
  error_code text,
  workspace_id text,
  revision timestamptz,
  duration_ms integer,
  cold_start_ms integer,
  query_scope jsonb,
  returned_records integer,
  payload_token_estimate integer,
  created_project_count integer not null default 0
);
create index if not exists idx_work_calendar_events_created_at on public.work_calendar_events (created_at desc);
alter table public.work_calendar_events add column if not exists created_project_count integer not null default 0;
alter table public.work_calendar_members enable row level security;
alter table public.work_calendar_events enable row level security;

-- The Edge Function uses the service role. Browser clients must never access these tables directly.
drop policy if exists "allow anon read app_state" on public.app_state;
drop policy if exists "allow anon upsert app_state" on public.app_state;
drop policy if exists "allow anon update app_state" on public.app_state;
drop policy if exists "allow anon read app_state_history" on public.app_state_history;
drop policy if exists "allow anon insert app_state_history" on public.app_state_history;

create or replace function public.apply_work_calendar_state(
  p_workspace_id text, p_state_name text, p_expected_revision timestamptz,
  p_payload jsonb, p_record_history boolean default false
) returns table(status text, revision timestamptz)
language plpgsql security definer set search_path = public as $$
declare v_id text := p_workspace_id || ':' || p_state_name; v_current timestamptz; v_next timestamptz := clock_timestamp();
begin
  select updated_at into v_current from app_state where id = v_id for update;
  if found and (p_expected_revision is null or v_current <> p_expected_revision) then
    return query select 'REVISION_MISMATCH'::text, v_current; return;
  end if;
  if not found and p_expected_revision is not null then
    return query select 'REVISION_MISMATCH'::text, null::timestamptz; return;
  end if;
  insert into app_state (id, payload, updated_at) values (v_id, p_payload, v_next)
  on conflict (id) do update set payload = excluded.payload, updated_at = excluded.updated_at;
  if p_record_history then
    insert into app_state_history (state_id, payload, created_at) values (v_id, p_payload, v_next);
  end if;
  return query select 'OK'::text, v_next;
end; $$;
revoke all on function public.apply_work_calendar_state(text, text, timestamptz, jsonb, boolean) from public;
grant execute on function public.apply_work_calendar_state(text, text, timestamptz, jsonb, boolean) to service_role;

create or replace function public.read_work_calendar_state(
  p_workspace_id text,
  p_state_name text
) returns table(payload jsonb, revision timestamptz)
language sql security definer set search_path = public as $$
  select s.payload, s.updated_at
  from app_state s
  where s.id = p_workspace_id || ':' || p_state_name;
$$;
revoke all on function public.read_work_calendar_state(text, text) from public;
grant execute on function public.read_work_calendar_state(text, text) to service_role;
