-- De-identified observability for the offline Skill quality loop.
-- These fields are diagnostic only; they are not accepted as authorization input.
alter table public.work_calendar_events
  add column if not exists skill_version text,
  add column if not exists evaluation_case_id text,
  add column if not exists failure_category text;

alter table public.work_calendar_events
  drop constraint if exists work_calendar_events_skill_version_length,
  add constraint work_calendar_events_skill_version_length check (skill_version is null or char_length(skill_version) <= 128),
  drop constraint if exists work_calendar_events_evaluation_case_id_shape,
  add constraint work_calendar_events_evaluation_case_id_shape check (evaluation_case_id is null or evaluation_case_id ~ '^[a-z0-9][a-z0-9-]{0,95}$'),
  drop constraint if exists work_calendar_events_failure_category_shape,
  add constraint work_calendar_events_failure_category_shape check (failure_category is null or failure_category ~ '^[A-Z_]{2,64}$');

create index if not exists idx_work_calendar_events_quality
  on public.work_calendar_events (skill_version, failure_category, created_at desc);
