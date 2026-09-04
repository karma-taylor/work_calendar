import assert from 'node:assert/strict'
import fs from 'node:fs'

const edge = fs.readFileSync(new URL('../supabase/functions/work-calendar/index.ts', import.meta.url), 'utf8')
const migration = fs.readFileSync(new URL('../supabase/migrations/202608230002_security_hardening.sql', import.meta.url), 'utf8')

assert.match(edge, /WORK_CALENDAR_ALLOWED_ORIGIN/)
assert.match(edge, /SERVER_MISCONFIGURED/)
assert.doesNotMatch(edge, /body\.workspaceId/)
assert.match(edge, /x-work-calendar-key-id/)
assert.match(edge, /work_calendar_api_keys/)
assert.match(edge, /deleteProjectIds/)
assert.match(edge, /INVALID_DELETE_REQUEST/)
assert.match(edge, /SCHEDULING_CONFLICT/)
assert.match(edge, /maxBodyBytes/)
assert.match(edge, /WORK_CALENDAR_SKILL_VERSION/)
assert.match(edge, /x-work-calendar-evaluation-case-id/)
assert.match(edge, /failure_category/)
assert.match(migration, /work_calendar_members[\s\S]*role/)
assert.match(migration, /purge_work_calendar_retention/)
assert.match(migration, /consume_work_calendar_login_rate/)
console.log('security contract checks passed')
