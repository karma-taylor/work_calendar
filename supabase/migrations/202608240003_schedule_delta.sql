-- Delta schedule model. app_state remains a compatibility snapshot; individual
-- assignments are stored as rows so a Patch never needs to replace the full roster.
create extension if not exists btree_gist;

create table if not exists public.schedule_revisions (
  workspace_id text primary key,
  revision timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create table if not exists public.schedule_projects (
  workspace_id text not null,
  project_id text not null,
  project_payload jsonb not null,
  start_date date not null,
  end_date date not null,
  primary key (workspace_id, project_id),
  check (start_date <= end_date)
);

create table if not exists public.schedule_shifts (
  workspace_id text not null,
  shift_id text primary key,
  project_id text not null,
  person_id text not null,
  role text not null check (role in ('manager', 'worker')),
  trade_tag text not null default '',
  start_date date not null,
  end_date date not null,
  note text not null default '',
  updated_at timestamptz not null default clock_timestamp(),
  check (start_date <= end_date),
  foreign key (workspace_id, project_id)
    references public.schedule_projects (workspace_id, project_id)
    on delete cascade
);

alter table public.schedule_shifts drop constraint if exists schedule_shifts_person_window_no_overlap;
alter table public.schedule_shifts add constraint schedule_shifts_person_window_no_overlap
  exclude using gist (
    workspace_id with =,
    person_id with =,
    daterange(start_date, end_date, '[]') with &&
  );
create index if not exists schedule_shifts_scope_idx
  on public.schedule_shifts (workspace_id, person_id, start_date, end_date);

alter table public.schedule_revisions enable row level security;
alter table public.schedule_projects enable row level security;
alter table public.schedule_shifts enable row level security;

-- Returns the JSON representation expected by the current web client and keeps
-- app_state as a read-compatible snapshot during the incremental migration.
create or replace function public.work_calendar_schedule_snapshot(p_workspace_id text)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(
    jsonb_set(
      p.project_payload,
      '{assignments}',
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', s.shift_id,
          'personId', s.person_id,
          'role', s.role,
          'trade', s.trade_tag,
          'segmentStart', to_char(s.start_date, 'YYYY-MM-DD'),
          'segmentEnd', to_char(s.end_date, 'YYYY-MM-DD'),
          'note', s.note
        ) order by s.start_date, s.shift_id)
        from public.schedule_shifts s
        where s.workspace_id = p.workspace_id and s.project_id = p.project_id
      ), '[]'::jsonb),
      true
    ) order by p.start_date, p.project_id
  ), '[]'::jsonb)
  from public.schedule_projects p
  where p.workspace_id = p_workspace_id;
$$;

-- Rebuild the normalized projection after a legacy whole-project write. This
-- preserves backwards compatibility while all callers migrate to Patch APIs.
create or replace function public.sync_work_calendar_schedule_from_state(p_workspace_id text)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare v_payload jsonb; v_revision timestamptz;
begin
  select payload, updated_at into v_payload, v_revision
  from public.app_state
  where id = p_workspace_id || ':projects'
  for update;
  if not found then
    return null;
  end if;

  delete from public.schedule_projects where workspace_id = p_workspace_id;
  insert into public.schedule_projects (workspace_id, project_id, project_payload, start_date, end_date)
  select p_workspace_id, item->>'id', item - 'assignments', (item->>'startDate')::date, (item->>'endDate')::date
  from jsonb_array_elements(v_payload) item;
  insert into public.schedule_shifts (workspace_id, shift_id, project_id, person_id, role, trade_tag, start_date, end_date, note, updated_at)
  select p_workspace_id, row->>'id', item->>'id', row->>'personId', row->>'role', coalesce(row->>'trade', ''),
    (row->>'segmentStart')::date, (row->>'segmentEnd')::date, coalesce(row->>'note', ''), v_revision
  from jsonb_array_elements(v_payload) item
  cross join lateral jsonb_array_elements(coalesce(item->'assignments', '[]'::jsonb)) row;
  insert into public.schedule_revisions (workspace_id, revision, updated_at)
  values (p_workspace_id, v_revision, v_revision)
  on conflict (workspace_id) do update set revision = excluded.revision, updated_at = excluded.updated_at;
  return v_revision;
end;
$$;

create or replace function public.read_work_calendar_schedule_scope(
  p_workspace_id text, p_person_ids text[], p_start date, p_end date
) returns table(revision timestamptz, shifts jsonb)
language sql stable security definer set search_path = public as $$
  select r.revision,
    coalesce(jsonb_agg(jsonb_build_object(
      'shift_id', s.shift_id,
      'project_id', s.project_id,
      'project_name', p.project_payload->>'name',
      'person_id', s.person_id,
      'role', s.role,
      'trade_tag', s.trade_tag,
      'start_date', to_char(s.start_date, 'YYYY-MM-DD'),
      'end_date', to_char(s.end_date, 'YYYY-MM-DD')
    ) order by s.start_date, s.shift_id) filter (where s.shift_id is not null), '[]'::jsonb)
  from public.schedule_revisions r
  left join public.schedule_shifts s on s.workspace_id = r.workspace_id
    and (cardinality(p_person_ids) = 0 or s.person_id = any(p_person_ids))
    and s.start_date <= p_end and s.end_date >= p_start
  left join public.schedule_projects p on p.workspace_id = s.workspace_id and p.project_id = s.project_id
  where r.workspace_id = p_workspace_id
  group by r.revision;
$$;

create or replace function public.apply_schedule_patch(
  p_workspace_id text, p_expected_revision timestamptz, p_patches jsonb, p_dry_run boolean default false
) returns table(status text, revision timestamptz, applied jsonb)
language plpgsql security definer set search_path = public as $$
declare
  v_current timestamptz; v_next timestamptz; v_patch jsonb; v_shift public.schedule_shifts%rowtype;
  v_old jsonb; v_new jsonb; v_new_person text; v_new_start date; v_new_end date;
  v_staff jsonb; v_project public.schedule_projects%rowtype; v_applied jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_patches) <> 'array' or jsonb_array_length(p_patches) = 0 or jsonb_array_length(p_patches) > 20 then
    return query select 'INVALID_PATCH'::text, null::timestamptz, '[]'::jsonb; return;
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_patches) item
    group by item->>'shift_id' having count(*) > 1 or item->>'shift_id' is null
  ) then return query select 'INVALID_PATCH'::text, null::timestamptz, '[]'::jsonb; return; end if;
  insert into public.schedule_revisions (workspace_id) values (p_workspace_id) on conflict do nothing;
  select sr.revision into v_current
  from public.schedule_revisions as sr
  where sr.workspace_id = p_workspace_id
  for update;
  if v_current <> p_expected_revision then
    return query select 'REVISION_MISMATCH'::text, v_current, '[]'::jsonb; return;
  end if;
  select payload into v_staff from public.app_state where id = p_workspace_id || ':staff';

  for v_patch in select value from jsonb_array_elements(p_patches) loop
    if not (v_patch ? 'action' and v_patch ? 'shift_id' and v_patch ? 'old' and v_patch ? 'new') then
      return query select 'INVALID_PATCH'::text, v_current, '[]'::jsonb; return;
    end if;
    select * into v_shift from public.schedule_shifts
    where workspace_id = p_workspace_id and shift_id = v_patch->>'shift_id' for update;
    if not found then return query select 'SHIFT_NOT_FOUND'::text, v_current, '[]'::jsonb; return; end if;
    v_old := v_patch->'old'; v_new := v_patch->'new';
    if coalesce(v_old->>'person_id', '') <> v_shift.person_id or coalesce(v_old->>'role', '') <> v_shift.role
      or coalesce(v_old->>'trade_tag', '') <> v_shift.trade_tag
      or coalesce(v_old->>'start_date', '') <> to_char(v_shift.start_date, 'YYYY-MM-DD')
      or coalesce(v_old->>'end_date', '') <> to_char(v_shift.end_date, 'YYYY-MM-DD') then
      return query select 'PATCH_PRECONDITION_FAILED'::text, v_current, '[]'::jsonb; return;
    end if;

    if v_patch->>'action' = 'replace_assignee' then
      v_new_person := v_new->>'person_id';
      if v_new_person is null then return query select 'INVALID_PATCH'::text, v_current, '[]'::jsonb; return; end if;
      if not exists (
        select 1 from jsonb_array_elements(coalesce(v_staff -> (case when v_shift.role = 'manager' then 'managers' else 'workers' end), '[]'::jsonb)) person
        where person->>'id' = v_new_person
          and (v_shift.role = 'manager' or person->>'tradeTag' = v_shift.trade_tag)
      ) then return query select 'PERSON_OR_TRADE_INVALID'::text, v_current, '[]'::jsonb; return; end if;
      if exists (select 1 from public.schedule_shifts s where s.workspace_id = p_workspace_id and s.person_id = v_new_person and s.shift_id <> v_shift.shift_id and s.start_date <= v_shift.end_date and s.end_date >= v_shift.start_date) then
        return query select 'SCHEDULING_CONFLICT'::text, v_current, '[]'::jsonb; return;
      end if;
      if not p_dry_run then update public.schedule_shifts set person_id = v_new_person, updated_at = clock_timestamp() where shift_id = v_shift.shift_id; end if;
      v_applied := v_applied || jsonb_build_array(jsonb_build_object('action', 'replace_assignee', 'shift_id', v_shift.shift_id, 'old_person_id', v_shift.person_id, 'new_person_id', v_new_person));
    elsif v_patch->>'action' = 'update_window' then
      v_new_start := (v_new->>'start_date')::date; v_new_end := (v_new->>'end_date')::date;
      select * into v_project from public.schedule_projects where workspace_id = p_workspace_id and project_id = v_shift.project_id;
      if v_new_start is null or v_new_end is null or v_new_start > v_new_end or v_new_start < v_project.start_date or v_new_end > v_project.end_date then return query select 'INVALID_PATCH'::text, v_current, '[]'::jsonb; return; end if;
      if exists (select 1 from public.schedule_shifts s where s.workspace_id = p_workspace_id and s.person_id = v_shift.person_id and s.shift_id <> v_shift.shift_id and s.start_date <= v_new_end and s.end_date >= v_new_start) then return query select 'SCHEDULING_CONFLICT'::text, v_current, '[]'::jsonb; return; end if;
      if not p_dry_run then update public.schedule_shifts set start_date = v_new_start, end_date = v_new_end, updated_at = clock_timestamp() where shift_id = v_shift.shift_id; end if;
      v_applied := v_applied || jsonb_build_array(jsonb_build_object('action', 'update_window', 'shift_id', v_shift.shift_id));
    elsif v_patch->>'action' = 'cancel_shift' then
      if not p_dry_run then delete from public.schedule_shifts where shift_id = v_shift.shift_id; end if;
      v_applied := v_applied || jsonb_build_array(jsonb_build_object('action', 'cancel_shift', 'shift_id', v_shift.shift_id));
    else
      return query select 'INVALID_PATCH'::text, v_current, '[]'::jsonb; return;
    end if;
  end loop;

  if p_dry_run then return query select 'OK'::text, v_current, v_applied; return; end if;
  v_next := clock_timestamp();
  update public.schedule_revisions set revision = v_next, updated_at = v_next where workspace_id = p_workspace_id;
  insert into public.app_state (id, payload, updated_at) values (p_workspace_id || ':projects', public.work_calendar_schedule_snapshot(p_workspace_id), v_next)
  on conflict (id) do update set payload = excluded.payload, updated_at = excluded.updated_at;
  insert into public.app_state_history (state_id, payload, created_at)
  values (p_workspace_id || ':projects', public.work_calendar_schedule_snapshot(p_workspace_id), v_next);
  return query select 'OK'::text, v_next, v_applied;
exception when exclusion_violation then
  return query select 'SCHEDULING_CONFLICT'::text, v_current, '[]'::jsonb;
end;
$$;

revoke all on function public.work_calendar_schedule_snapshot(text) from public;
revoke all on function public.sync_work_calendar_schedule_from_state(text) from public;
revoke all on function public.read_work_calendar_schedule_scope(text, text[], date, date) from public;
revoke all on function public.apply_schedule_patch(text, timestamptz, jsonb, boolean) from public;
grant execute on function public.work_calendar_schedule_snapshot(text) to service_role;
grant execute on function public.sync_work_calendar_schedule_from_state(text) to service_role;
grant execute on function public.read_work_calendar_schedule_scope(text, text[], date, date) to service_role;
grant execute on function public.apply_schedule_patch(text, timestamptz, jsonb, boolean) to service_role;

select public.sync_work_calendar_schedule_from_state('default');
