const apiUrl = process.env.WORK_CALENDAR_API_URL?.replace(/\/$/, '')
const apiKey = process.env.WORK_CALENDAR_API_KEY
const apiKeyId = process.env.WORK_CALENDAR_API_KEY_ID
const stagingRef = process.env.WORK_CALENDAR_STAGING_PROJECT_REF ?? 'djnknltowfrenlyjbvad'
const apply = process.argv.includes('--apply')

if (!apiUrl || !apiKey || !apiKeyId) throw new Error('Set WORK_CALENDAR_API_URL, WORK_CALENDAR_API_KEY, and WORK_CALENDAR_API_KEY_ID.')
if (process.env.WORK_CALENDAR_STAGE !== 'staging' || !new URL(apiUrl).hostname.startsWith(`${stagingRef}.supabase.co`)) throw new Error('Refusing to test outside the configured staging project.')
const headers = { Origin: 'http://localhost:5173', 'x-work-calendar-key': apiKey, 'x-work-calendar-key-id': apiKeyId }
async function request(method, path, payload) {
  const response = await fetch(`${apiUrl}${path}`, { method, headers: payload ? { ...headers, 'Content-Type': 'application/json' } : headers, body: payload ? JSON.stringify(payload) : undefined })
  return { status: response.status, body: await response.json() }
}

const state = await request('POST', '', { action: 'read', scope: { full: true } })
if (state.status !== 200 || !state.body.projects?.length) throw new Error('No staged projects found. Run seed-staging.ts --apply first.')
const sourceProject = state.body.projects.find((project) => project.id.startsWith('seed-project-'))
const source = sourceProject?.assignments.find((assignment) => assignment.role === 'worker')
if (!source) throw new Error('No seeded worker shift found.')
const allWorkers = state.body.staff.workers
const sourceWorker = allWorkers.find((worker) => worker.id === source.personId)
const target = allWorkers.find((worker) => worker.id !== source.personId && worker.tradeTag === sourceWorker?.tradeTag && !sourceProject.assignments.some((assignment) => assignment.personId === worker.id))
if (!target) throw new Error('No compatible unassigned replacement worker found.')
const patch = { expectedRevision: state.body.revision, patches: [{ action: 'replace_assignee', shift_id: source.id, old: { person_id: source.personId, role: source.role, trade_tag: source.trade, start_date: source.segmentStart, end_date: source.segmentEnd }, new: { person_id: target.id } }] }
const preview = await request('POST', '/schedule/preview', patch)
const conflictingTarget = sourceProject.assignments.find((assignment) => assignment.id !== source.id && assignment.role === 'worker' && assignment.trade === source.trade)
if (!conflictingTarget) throw new Error('Seed fixture must include another worker with the same trade in the source project.')
const conflictPatch = { ...patch, patches: [{ ...patch.patches[0], new: { person_id: conflictingTarget.personId } }] }
const conflictPreview = await request('POST', '/schedule/preview', conflictPatch)
console.log(JSON.stringify({ mode: apply ? 'apply' : 'preview-only', sourceShift: source.id, validPreview: preview, conflictPreview }, null, 2))
if (preview.status !== 200 || conflictPreview.status !== 422 || conflictPreview.body.error !== 'SCHEDULING_CONFLICT') process.exit(1)
if (!apply) process.exit(0)
const first = await request('PATCH', '/schedule', patch)
const stale = await request('PATCH', '/schedule', patch)
if (first.status !== 200 || stale.status !== 409 || stale.body.error !== 'REVISION_MISMATCH') {
  console.error(JSON.stringify({ first, stale }, null, 2)); process.exit(1)
}
console.log(JSON.stringify({ ok: true, firstWrite: first.status, staleWrite: stale.status, staleCode: stale.body.error }, null, 2))
