import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const example = JSON.parse(readFileSync(new URL('../examples/patch_payload.json', import.meta.url), 'utf8'))
const edge = readFileSync(new URL('../supabase/functions/work-calendar/index.ts', import.meta.url), 'utf8')
const migration = readFileSync(new URL('../supabase/migrations/202608240003_schedule_delta.sql', import.meta.url), 'utf8')

assert.equal(typeof example.expectedRevision, 'string')
assert.ok(example.expectedRevision.length > 0)
assert.equal(example.patches.length, 1)
const [patch] = example.patches
assert.equal(patch.action, 'replace_assignee')
assert.ok(patch.shift_id)
assert.deepEqual(Object.keys(patch.new), ['person_id'])
assert.deepEqual(Object.keys(patch.old).sort(), ['end_date', 'person_id', 'role', 'start_date', 'trade_tag'])

assert.match(edge, /req\.method === 'PATCH' && schedulePath/)
assert.match(edge, /parseSchedulePatch/)
assert.match(edge, /apply_schedule_patch/)
assert.match(edge, /p_dry_run: schedulePreviewPath/)
assert.match(edge, /sync_work_calendar_schedule_from_state/)

assert.match(migration, /create table if not exists public\.schedule_shifts/)
assert.match(migration, /schedule_shifts_person_window_no_overlap/)
assert.match(migration, /for update/)
assert.match(migration, /REVISION_MISMATCH/)
assert.match(migration, /PATCH_PRECONDITION_FAILED/)
assert.match(migration, /p_dry_run boolean default false/)

console.log('schedule patch contract checks passed')
