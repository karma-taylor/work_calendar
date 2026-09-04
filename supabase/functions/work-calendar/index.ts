import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

type Role = 'viewer' | 'scheduler' | 'roster_admin'
type Principal = { channel: 'web' | 'skill' | 'system'; role: Role; userId?: string; keyId?: string }
type SchedulePatchAction = 'replace_assignee' | 'update_window' | 'cancel_shift'
type SchedulePatch = {
  action: SchedulePatchAction
  shift_id: string
  old: { person_id: string; role: 'manager' | 'worker'; trade_tag: string; start_date: string; end_date: string }
  new: Record<string, string>
}
const allowedOrigins = (Deno.env.get('WORK_CALENDAR_ALLOWED_ORIGIN') || '').split(',').map((value) => value.trim()).filter(Boolean)
const workspaceId = Deno.env.get('WORK_CALENDAR_WORKSPACE_ID') || 'default'
const maxBodyBytes = 64 * 1024, maxProjects = 200, maxAssignments = 100
const datePattern = /^\d{4}-\d{2}-\d{2}$/, idPattern = /^[A-Za-z0-9_-]{1,96}$/, staffIdPattern = /^staff-[A-Za-z0-9_-]{1,64}$/, aliasPattern = /^[\u3400-\u9fff]{2,4}$/u
const knownSources = new Set(['江都', '省建', '科林', 'CSI'])
const rank: Record<Role, number> = { viewer: 0, scheduler: 1, roster_admin: 2 }
const asObject = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value: unknown, keys: string[]) => asObject(value) && Object.keys(value).every((key) => keys.includes(key))
const validDate = (value: unknown) => typeof value === 'string' && datePattern.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
const overlap = (aStart: string, aEnd: string, bStart: string, bEnd: string) => aStart <= bEnd && bStart <= aEnd
const can = (principal: Principal, required: Role) => rank[principal.role] >= rank[required]
const estimateTokens = (value: unknown) => Math.ceil(JSON.stringify(value).length / 4)
const allowedOrigin = (origin: string | null) => Boolean(origin && allowedOrigins.includes(origin))
const diagnosticCasePattern = /^[a-z0-9][a-z0-9-]{0,95}$/
const failureCategory = (errorCode?: string) => {
  if (!errorCode) return null
  if (['SCHEDULING_CONFLICT', 'PATCH_PRECONDITION_FAILED', 'SHIFT_NOT_FOUND'].includes(errorCode)) return 'SCHEDULE_VALIDATION'
  if (errorCode === 'REVISION_MISMATCH') return 'REVISION_MISMATCH'
  if (['FORBIDDEN', 'NOT_ALLOWLISTED', 'INVALID_JWT', 'INVALID_API_KEY', 'UNAUTHORIZED'].includes(errorCode)) return 'AUTHORIZATION'
  if (['INVALID_PATCH', 'INVALID_SCOPE', 'INVALID_PAYLOAD', 'INVALID_PROJECT', 'INVALID_ASSIGNMENT'].includes(errorCode)) return 'REQUEST_VALIDATION'
  return 'INTERNAL'
}
const cors = (origin: string | null) => allowedOrigin(origin) ? { 'Access-Control-Allow-Origin': origin!, Vary: 'Origin', 'Access-Control-Allow-Headers': 'authorization, content-type, x-work-calendar-key, x-work-calendar-key-id, x-work-calendar-evaluation-case-id', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS' } : {}
const reply = (body: unknown, status = 200, origin: string | null = null) => new Response(JSON.stringify(body), { status, headers: { ...cors(origin), 'Content-Type': 'application/json' } })
async function sha256(value: string) { const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)); return Array.from(new Uint8Array(bytes)).map((part) => part.toString(16).padStart(2, '0')).join('') }

function runtimeServiceKey() {
  const configuredKey = Deno.env.get('WORK_CALENDAR_DATABASE_KEY')
  if (configuredKey) return configuredKey
  const modernKeys = Deno.env.get('SUPABASE_SECRET_KEYS')
  if (modernKeys) {
    try {
      const parsed = JSON.parse(modernKeys) as Record<string, unknown>
      if (typeof parsed.default === 'string' && parsed.default) return parsed.default
    } catch {
      // Fall through for projects that have not enabled the new API-key system.
    }
  }
  const legacyKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (legacyKey) return legacyKey
  throw new Error('SERVER_MISCONFIGURED')
}

function parseSchedulePatch(body: unknown) {
  if (!asObject(body) || typeof body.expectedRevision !== 'string' || !body.expectedRevision || !Array.isArray(body.patches) || !body.patches.length || body.patches.length > 20) throw new Error('INVALID_PATCH')
  const shiftIds = new Set<string>()
  for (const patch of body.patches) {
    if (!asObject(patch) || !['replace_assignee', 'update_window', 'cancel_shift'].includes(String(patch.action)) || typeof patch.shift_id !== 'string' || !idPattern.test(patch.shift_id) || shiftIds.has(patch.shift_id) || !asObject(patch.old) || !asObject(patch.new)) throw new Error('INVALID_PATCH')
    const old = patch.old, next = patch.new
    if (typeof old.person_id !== 'string' || !staffIdPattern.test(old.person_id) || (old.role !== 'manager' && old.role !== 'worker') || typeof old.trade_tag !== 'string' || !validDate(old.start_date) || !validDate(old.end_date) || old.start_date > old.end_date) throw new Error('INVALID_PATCH')
    if (patch.action === 'replace_assignee' && (Object.keys(next).length !== 1 || typeof next.person_id !== 'string' || !staffIdPattern.test(next.person_id))) throw new Error('INVALID_PATCH')
    if (patch.action === 'update_window' && (Object.keys(next).length !== 2 || !validDate(next.start_date) || !validDate(next.end_date) || next.start_date > next.end_date)) throw new Error('INVALID_PATCH')
    if (patch.action === 'cancel_shift' && Object.keys(next).length) throw new Error('INVALID_PATCH')
    shiftIds.add(patch.shift_id)
  }
  return { expectedRevision: body.expectedRevision, patches: body.patches as SchedulePatch[] }
}

function validateProjects(projects: unknown, staff: any) {
  if (!Array.isArray(projects) || projects.length > maxProjects) throw new Error('INVALID_PROJECTS')
  const people = new Map<string, Role>()
  for (const person of staff?.managers || []) people.set(person.id, 'viewer')
  for (const person of staff?.workers || []) people.set(person.id, 'scheduler')
  const projectIds = new Set<string>(), assignmentIds = new Set<string>(), byPerson = new Map<string, any[]>()
  for (const project of projects) {
    const allowed = ['id', 'name', 'startDate', 'endDate', 'assignments', 'managerIds', 'workerIds', 'managerEnabled', 'workerEnabled']
    if (!exactKeys(project, allowed) || typeof project.id !== 'string' || !idPattern.test(project.id) || projectIds.has(project.id) || typeof project.name !== 'string' || !project.name.trim() || project.name.length > 120 || !validDate(project.startDate) || !validDate(project.endDate) || project.startDate > project.endDate || !Array.isArray(project.assignments) || project.assignments.length > maxAssignments) throw new Error('INVALID_PROJECT')
    projectIds.add(project.id)
    for (const assignment of project.assignments) {
      const keys = ['id', 'personId', 'role', 'trade', 'segmentStart', 'segmentEnd', 'note']
      if (!exactKeys(assignment, keys) || typeof assignment.id !== 'string' || !idPattern.test(assignment.id) || assignmentIds.has(assignment.id) || typeof assignment.personId !== 'string' || !staffIdPattern.test(assignment.personId) || (assignment.role !== 'manager' && assignment.role !== 'worker') || (assignment.role === 'manager' && people.get(assignment.personId) !== 'viewer') || (assignment.role === 'worker' && people.get(assignment.personId) !== 'scheduler') || typeof assignment.trade !== 'string' || assignment.trade.length > 64 || typeof assignment.note !== 'string' || assignment.note.length > 500 || !validDate(assignment.segmentStart) || !validDate(assignment.segmentEnd) || assignment.segmentStart > assignment.segmentEnd || assignment.segmentStart < project.startDate || assignment.segmentEnd > project.endDate) throw new Error('INVALID_ASSIGNMENT')
      assignmentIds.add(assignment.id); byPerson.set(assignment.personId, [...(byPerson.get(assignment.personId) || []), { project, assignment }])
    }
  }
  for (const [personId, entries] of byPerson) {
    entries.sort((a, b) => a.assignment.segmentStart.localeCompare(b.assignment.segmentStart) || a.assignment.segmentEnd.localeCompare(b.assignment.segmentEnd))
    for (let index = 1; index < entries.length; index += 1) if (overlap(entries[index - 1].assignment.segmentStart, entries[index - 1].assignment.segmentEnd, entries[index].assignment.segmentStart, entries[index].assignment.segmentEnd)) throw new Error(`SCHEDULING_CONFLICT:${personId}`)
  }
  return projects
}

function validateStaff(staff: unknown, existing: any) {
  if (!exactKeys(staff, ['managers', 'workers']) || !asObject(staff) || !Array.isArray(staff.managers) || !Array.isArray(staff.workers) || staff.managers.length + staff.workers.length > 1000) throw new Error('INVALID_STAFF')
  const oldRoles = new Map<string, 'manager' | 'worker'>(); for (const person of existing?.managers || []) oldRoles.set(person.id, 'manager'); for (const person of existing?.workers || []) oldRoles.set(person.id, 'worker')
  const ids = new Set<string>()
  for (const [role, group] of [['manager', staff.managers], ['worker', staff.workers]] as const) for (const person of group) {
    if (!exactKeys(person, ['id', 'name', 'title', 'tradeTag', 'sourceSheet']) || !asObject(person) || typeof person.id !== 'string' || !staffIdPattern.test(person.id) || ids.has(person.id) || typeof person.name !== 'string' || !aliasPattern.test(person.name) || typeof person.title !== 'string' || person.title.length > 64 || typeof person.tradeTag !== 'string' || !person.tradeTag.trim() || person.tradeTag.length > 64 || typeof person.sourceSheet !== 'string' || !knownSources.has(person.sourceSheet) || (role === 'worker' && person.sourceSheet === 'CSI') || (oldRoles.has(person.id) && oldRoles.get(person.id) !== role)) throw new Error('INVALID_STAFF_MEMBER')
    ids.add(person.id)
  }
  return staff
}

function candidate(operation: string, body: Record<string, any>, existing: any[]) {
  if (operation === 'create_project') { if (!asObject(body.project) || existing.some((project) => project.id === body.project.id)) throw new Error('INVALID_CREATE'); return [...existing, body.project] }
  if (operation === 'update_project') { if (!asObject(body.project) || !existing.some((project) => project.id === body.project.id)) throw new Error('PROJECT_NOT_FOUND'); return existing.map((project) => project.id === body.project.id ? body.project : project) }
  if (operation === 'delete_projects') { if (!Array.isArray(body.deleteProjectIds) || !body.deleteProjectIds.length || !body.deleteProjectIds.every((id: unknown) => typeof id === 'string' && idPattern.test(id))) throw new Error('INVALID_DELETE_REQUEST'); const ids = new Set(body.deleteProjectIds); if (ids.size !== body.deleteProjectIds.length || [...ids].some((id) => !existing.some((project) => project.id === id))) throw new Error('PROJECT_NOT_FOUND'); return existing.filter((project) => !ids.has(project.id)) }
  throw new Error('INVALID_MUTATION')
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin')
  const url = new URL(req.url)
  const schedulePath = url.pathname.endsWith('/schedule')
  const schedulePreviewPath = url.pathname.endsWith('/schedule/preview')
  if (!allowedOrigins.length) return reply({ error: 'SERVER_MISCONFIGURED' }, 500, origin)
  if (origin && !allowedOrigin(origin)) return reply({ error: 'ORIGIN_NOT_ALLOWED' }, 403, origin)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(origin) })
  if (!((req.method === 'GET' && schedulePath) || (req.method === 'PATCH' && schedulePath) || (req.method === 'POST' && schedulePreviewPath) || req.method === 'POST')) return reply({ error: 'METHOD_NOT_ALLOWED' }, 405, origin)
  if (Number(req.headers.get('content-length') || '0') > maxBodyBytes) return reply({ error: 'PAYLOAD_TOO_LARGE' }, 413, origin)
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, runtimeServiceKey())
  const requestId = crypto.randomUUID(), started = performance.now(); let operation = 'unknown'; let principal: Principal = { channel: 'system', role: 'viewer' }
  const evaluationCaseId = req.headers.get('x-work-calendar-evaluation-case-id') || null
  const audit = async (success: boolean, errorCode?: string, extra: Record<string, unknown> = {}) => admin.from('work_calendar_events').insert({ actor_channel: principal.channel, actor_user_id: principal.userId || null, actor_key_id: principal.keyId || null, actor_role: principal.role, request_id: requestId, operation, success, error_code: errorCode || null, workspace_id: workspaceId, duration_ms: Math.round(performance.now() - started), skill_version: principal.channel === 'skill' ? Deno.env.get('WORK_CALENDAR_SKILL_VERSION') || null : null, evaluation_case_id: principal.channel === 'skill' && evaluationCaseId && diagnosticCasePattern.test(evaluationCaseId) ? evaluationCaseId : null, failure_category: failureCategory(errorCode), ...extra })
  try {
    const raw = req.method === 'GET' ? '' : await req.text(); if (raw.length > maxBodyBytes) return reply({ error: 'PAYLOAD_TOO_LARGE' }, 413, origin)
    const body: unknown = req.method === 'GET' ? {} : JSON.parse(raw)
    if (!schedulePath && !schedulePreviewPath && (!asObject(body) || typeof body.action !== 'string')) return reply({ error: 'INVALID_PAYLOAD' }, 400, origin)
    operation = schedulePath ? (req.method === 'GET' ? 'read_schedule' : 'patch_schedule') : schedulePreviewPath ? 'preview_schedule_patch' : (body as Record<string, any>).action
    if (operation === 'request_login') {
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '', ip = req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || 'unknown'
      const [{ data: emailAllowed }, { data: ipAllowed }, { data: member }] = await Promise.all([admin.rpc('consume_work_calendar_login_rate', { p_bucket: await sha256(`email:${email}`) }), admin.rpc('consume_work_calendar_login_rate', { p_bucket: await sha256(`ip:${ip}`) }), email ? admin.from('work_calendar_members').select('email').eq('email', email).eq('is_active', true).maybeSingle() : Promise.resolve({ data: null })])
      const shouldSend = Boolean(emailAllowed && ipAllowed && member)
      await audit(shouldSend, emailAllowed && ipAllowed ? 'LOGIN_NOT_ALLOWED' : 'LOGIN_RATE_LIMITED'); return reply({ ok: true, shouldSend }, 200, origin)
    }
    const key = req.headers.get('x-work-calendar-key'), keyId = req.headers.get('x-work-calendar-key-id')
    if (key && keyId) {
      const { data: apiKey } = await admin.from('work_calendar_api_keys').select('key_id,key_hash,role,is_active,expires_at').eq('key_id', keyId).maybeSingle()
      if (!apiKey || !apiKey.is_active || (apiKey.expires_at && new Date(apiKey.expires_at) <= new Date()) || apiKey.key_hash !== await sha256(key)) { await audit(false, 'INVALID_API_KEY'); return reply({ error: 'UNAUTHORIZED' }, 401, origin) }
      principal = { channel: 'skill', role: apiKey.role as Role, keyId: apiKey.key_id }
    } else {
      const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, ''), { data: userData } = token ? await admin.auth.getUser(token) : { data: { user: null } }; const user = userData.user, email = user?.email?.toLowerCase()
      if (!user || !email) { await audit(false, 'INVALID_JWT'); return reply({ error: 'UNAUTHORIZED' }, 401, origin) }
      const { data: member } = await admin.from('work_calendar_members').select('user_id,role,is_active,revoked_at').eq('email', email).maybeSingle()
      if (!member || !member.is_active || member.revoked_at || (member.user_id && member.user_id !== user.id)) { await audit(false, 'NOT_ALLOWLISTED'); return reply({ error: 'FORBIDDEN' }, 403, origin) }
      if (!member.user_id) await admin.from('work_calendar_members').update({ user_id: user.id }).eq('email', email).is('user_id', null)
      principal = { channel: 'web', role: member.role as Role, userId: user.id }
    }
    const getState = async (name: 'projects' | 'staff') => { const { data, error } = await admin.rpc('read_work_calendar_state', { p_workspace_id: workspaceId, p_state_name: name }).maybeSingle(); if (error) throw error; return data ? { payload: data.payload, revision: data.revision } : { payload: name === 'projects' ? [] : { managers: [], workers: [] }, revision: null } }
    const writeState = (name: 'projects' | 'staff', payload: unknown, revision: unknown, history: boolean) => admin.rpc('apply_work_calendar_state', { p_workspace_id: workspaceId, p_state_name: name, p_expected_revision: typeof revision === 'string' ? revision : null, p_payload: payload, p_record_history: history })
    if (schedulePath && req.method === 'GET') {
      const personIds = url.searchParams.getAll('person_id')
      const start = url.searchParams.get('start'), end = url.searchParams.get('end')
      if (!start || !end || !validDate(start) || !validDate(end) || start > end || personIds.some((id) => !staffIdPattern.test(id))) { await audit(false, 'INVALID_SCOPE'); return reply({ error: 'INVALID_SCOPE' }, 400, origin) }
      const [{ data: schedule, error: scheduleError }, staff] = await Promise.all([
        admin.rpc('read_work_calendar_schedule_scope', { p_workspace_id: workspaceId, p_person_ids: personIds, p_start: start, p_end: end }).maybeSingle(),
        getState('staff'),
      ])
      if (scheduleError) throw scheduleError
      const people = [...((staff.payload as any).managers || []), ...((staff.payload as any).workers || [])]
        .filter((person: any) => personIds.includes(person.id))
        .map(({ id, name, sourceSheet, tradeTag }: any) => ({ id, name, sourceSheet, tradeTag }))
      const result = { revision: schedule?.revision || null, shifts: schedule?.shifts || [], people }
      await audit(true, undefined, { revision: result.revision, query_scope: { personIds, start, end }, returned_records: result.shifts.length, payload_token_estimate: estimateTokens(result) })
      return reply(result, 200, origin)
    }
    if ((schedulePath && req.method === 'PATCH') || schedulePreviewPath) {
      if (!can(principal, 'scheduler')) { await audit(false, 'FORBIDDEN'); return reply({ error: 'FORBIDDEN' }, 403, origin) }
      const { expectedRevision, patches } = parseSchedulePatch(body)
      const { data, error } = await admin.rpc('apply_schedule_patch', { p_workspace_id: workspaceId, p_expected_revision: expectedRevision, p_patches: patches, p_dry_run: schedulePreviewPath })
      if (error) throw error
      const result = Array.isArray(data) ? data[0] : data
      if (!result || result.status !== 'OK') {
        const code = result?.status || 'INTERNAL_ERROR', status = code === 'REVISION_MISMATCH' || code === 'PATCH_PRECONDITION_FAILED' ? 409 : code === 'SHIFT_NOT_FOUND' ? 404 : code === 'FORBIDDEN' ? 403 : 422
        await audit(false, code, { revision: result?.revision || null, change_summary: { shift_ids: patches.map((patch) => patch.shift_id) } })
        return reply({ error: code, revision: result?.revision || null }, status, origin)
      }
      await audit(true, undefined, { revision: result.revision, returned_records: patches.length, payload_token_estimate: estimateTokens(patches), change_summary: { operation, shift_ids: patches.map((patch) => patch.shift_id), actions: patches.map((patch) => patch.action) } })
      return reply({ ok: true, revision: result.revision, applied: result.applied || [] }, 200, origin)
    }
    if (operation === 'read') {
      const [projects, staff] = await Promise.all([getState('projects'), getState('staff')]); const scope = asObject(body.scope) ? body.scope : {}; const visible = (projects.payload as any[]).filter((project) => (!scope.projectId || project.id === scope.projectId) && (!scope.start || !scope.end || overlap(project.startDate, project.endDate, String(scope.start), String(scope.end)))).slice(0, 200); const simplify = (group: any[]) => group.map(({ id, name, sourceSheet, tradeTag }) => ({ id, name, sourceSheet, tradeTag }))
      const result = { projects: visible, staff: { managers: simplify((staff.payload as any).managers || []), workers: simplify((staff.payload as any).workers || []) }, revision: projects.revision, staffRevision: staff.revision, capabilities: { role: principal.role, canSchedule: can(principal, 'scheduler'), canManageRoster: can(principal, 'roster_admin'), canViewMetrics: can(principal, 'roster_admin') } }
      await audit(true, undefined, { revision: projects.revision, query_scope: scope, returned_records: visible.length, payload_token_estimate: estimateTokens(result) }); return reply(result, 200, origin)
    }
    if (operation === 'preview' || operation === 'create_project' || operation === 'update_project' || operation === 'delete_projects') {
      if (!can(principal, 'scheduler')) { await audit(false, 'FORBIDDEN'); return reply({ error: 'FORBIDDEN' }, 403, origin) }
      const [projects, staff] = await Promise.all([getState('projects'), getState('staff')]); const command = operation === 'preview' ? String(body.mutation || '') : operation; const next = validateProjects(candidate(command, body, projects.payload as any[]), staff.payload)
      if (operation === 'preview') { await audit(true, undefined, { returned_records: next.length, payload_token_estimate: estimateTokens(next) }); return reply({ ok: true }, 200, origin) }
      const { data: applied, error } = await writeState('projects', next, body.expectedRevision, true); if (error) throw error
      const appliedState = Array.isArray(applied) ? applied[0] : applied
      if (!appliedState || appliedState.status === 'REVISION_MISMATCH') { await audit(false, 'REVISION_MISMATCH', { revision: appliedState?.revision || null }); return reply({ error: 'REVISION_MISMATCH', revision: appliedState?.revision || null }, 409, origin) }
      if (appliedState.status !== 'OK') throw new Error('STATE_WRITE_FAILED')
      const { error: syncError } = await admin.rpc('sync_work_calendar_schedule_from_state', { p_workspace_id: workspaceId }); if (syncError) throw syncError
      await audit(true, undefined, { revision: appliedState.revision, returned_records: next.length, payload_token_estimate: estimateTokens(next), created_project_count: operation === 'create_project' ? 1 : 0, change_summary: { operation, project_ids: operation === 'delete_projects' ? body.deleteProjectIds : [body.project.id] } }); return reply({ ok: true, revision: appliedState.revision }, 200, origin)
    }
    if (operation === 'apply_staff') {
      if (!can(principal, 'roster_admin')) { await audit(false, 'FORBIDDEN'); return reply({ error: 'FORBIDDEN' }, 403, origin) }
      const existing = await getState('staff'), next = validateStaff(body.staff, existing.payload); const { data: applied, error } = await writeState('staff', next, body.expectedRevision, false); if (error) throw error
      const appliedState = Array.isArray(applied) ? applied[0] : applied
      if (!appliedState || appliedState.status === 'REVISION_MISMATCH') { await audit(false, 'REVISION_MISMATCH', { revision: appliedState?.revision || null }); return reply({ error: 'REVISION_MISMATCH', revision: appliedState?.revision || null }, 409, origin) }
      if (appliedState.status !== 'OK') throw new Error('STATE_WRITE_FAILED')
      await audit(true, undefined, { revision: appliedState.revision, returned_records: next.managers.length + next.workers.length, change_summary: { managers: next.managers.length, workers: next.workers.length } }); return reply({ ok: true, revision: appliedState.revision }, 200, origin)
    }
    if (operation === 'metrics') {
      if (!can(principal, 'roster_admin')) { await audit(false, 'FORBIDDEN'); return reply({ error: 'FORBIDDEN' }, 403, origin) }
      const since = typeof body.since === 'string' && new Date(body.since) > new Date(Date.now() - 90 * 86400000) ? body.since : new Date(Date.now() - 30 * 86400000).toISOString(); const { data, error } = await admin.from('work_calendar_events').select('actor_channel,actor_role,operation,success,error_code,failure_category,skill_version,evaluation_case_id,duration_ms,payload_token_estimate,created_project_count,created_at').gte('created_at', since).order('created_at', { ascending: false }).limit(1000); if (error) throw error; await audit(true); return reply({ events: data || [] }, 200, origin)
    }
    await audit(false, 'UNKNOWN_ACTION'); return reply({ error: 'UNKNOWN_ACTION' }, 400, origin)
  } catch (error) { const code = error instanceof Error && /^[A-Z_]+(?::[A-Za-z0-9_-]+)?$/.test(error.message) ? error.message.split(':')[0] : 'INTERNAL_ERROR'; await audit(false, code); return reply({ error: code }, code === 'SCHEDULING_CONFLICT' ? 422 : 400, origin) }
})
