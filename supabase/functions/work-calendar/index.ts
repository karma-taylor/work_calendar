import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = { 'Access-Control-Allow-Origin': Deno.env.get('WORK_CALENDAR_ALLOWED_ORIGIN') || '*', 'Access-Control-Allow-Headers': 'authorization, content-type, x-work-calendar-key', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
const estimateTokens = (value: unknown) => Math.ceil(JSON.stringify(value).length / 4)
const stateId = (workspaceId: string, name: string) => `${workspaceId}:${name}`
const overlap = (aStart: string, aEnd: string, bStart: string, bEnd: string) => aStart <= bEnd && bStart <= aEnd
const assignments = (project: any) => Array.isArray(project?.assignments) ? project.assignments : []
function validateProjects(projects: any[], staff: any) {
  const people = new Map([...(staff?.managers || []), ...(staff?.workers || [])].map((p: any) => [p.id, p]))
  const conflicts: { person: string; project: string; otherProject: string }[] = []
  for (const project of projects) {
    if (!project?.name || !project?.startDate || !project?.endDate || project.startDate > project.endDate) return { valid: false, code: 'INVALID_PROJECT', conflicts }
    for (const row of assignments(project)) if (!people.has(row.personId) || !row.segmentStart || !row.segmentEnd || row.segmentStart > row.segmentEnd || row.segmentStart < project.startDate || row.segmentEnd > project.endDate) return { valid: false, code: 'INVALID_ASSIGNMENT', conflicts }
  }
  for (let i = 0; i < projects.length; i += 1) for (let j = i + 1; j < projects.length; j += 1) for (const left of assignments(projects[i])) for (const right of assignments(projects[j])) if (left.personId === right.personId && overlap(left.segmentStart, left.segmentEnd, right.segmentStart, right.segmentEnd)) { const person = people.get(left.personId); conflicts.push({ person: `${person.name}(${person.sourceSheet})`, project: projects[i].name, otherProject: projects[j].name }) }
  return { valid: conflicts.length === 0, code: conflicts.length ? 'SCHEDULING_CONFLICT' : null, conflicts }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  const started = performance.now(); const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  let body: any = {}; let actorChannel = 'web'; let operation = 'unknown'; let workspaceId: string | null = null
  const log = async (success: boolean, errorCode?: string, extra: Record<string, unknown> = {}) => { await admin.from('work_calendar_events').insert({ actor_channel: actorChannel, operation, success, error_code: errorCode || null, workspace_id: workspaceId, duration_ms: Math.round(performance.now() - started), ...extra }) }
  try {
    body = await req.json(); operation = body.action; workspaceId = body.workspaceId || 'default'
    const suppliedKey = req.headers.get('x-work-calendar-key')
    if (suppliedKey && suppliedKey === Deno.env.get('WORK_CALENDAR_API_KEY')) actorChannel = 'skill'
    else {
      const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, ''); if (!token) { await log(false, 'MISSING_CREDENTIALS'); return json({ error: 'UNAUTHORIZED' }, 401) }
      const { data: userData } = await admin.auth.getUser(token); const email = userData.user?.email?.toLowerCase()
      if (!email) { await log(false, 'INVALID_JWT'); return json({ error: 'UNAUTHORIZED' }, 401) }
      const { data: member } = await admin.from('work_calendar_members').select('email').eq('email', email).maybeSingle()
      if (!member) { await log(false, 'NOT_ALLOWLISTED'); return json({ error: 'FORBIDDEN' }, 403) }
    }
    const getState = async (name: string) => {
      const { data, error } = await admin.rpc('read_work_calendar_state', { p_workspace_id: workspaceId, p_state_name: name }).maybeSingle()
      if (error) throw error
      return data ? { payload: data.payload, updated_at: data.revision } : null
    }
    if (operation === 'read') {
      const [projects, staff] = await Promise.all([getState('projects'), getState('staff')]); let visibleProjects = projects?.payload || []; const scope = body.scope || {}
      if (!scope.full) {
        visibleProjects = visibleProjects.filter((project: any) => (!scope.projectId || project.id === scope.projectId) && (!scope.personId || assignments(project).some((row: any) => row.personId === scope.personId)) && (!scope.start || !scope.end || overlap(project.startDate, project.endDate, scope.start, scope.end)))
      }
      let truncated = false
      if (!scope.full && estimateTokens({ projects: visibleProjects, staff: staff?.payload || {} }) > 2000) { visibleProjects = visibleProjects.slice(0, scope.limit || 25); truncated = true }
      const result = { projects: visibleProjects, staff: staff?.payload || { managers: [], workers: [] }, revision: projects?.updated_at || null, staffRevision: staff?.updated_at || null, truncated }
      await log(true, undefined, { revision: projects?.updated_at || null, query_scope: scope, returned_records: result.projects.length, payload_token_estimate: estimateTokens(result) }); return json(result)
    }
    if (operation === 'preview' || operation === 'apply') {
      if (!Array.isArray(body.projects)) { await log(false, 'INVALID_PAYLOAD'); return json({ error: 'INVALID_PAYLOAD' }, 400) }
      const [staff, existing] = await Promise.all([getState('staff'), getState('projects')]); const validation = validateProjects(body.projects, staff?.payload)
      if (operation === 'preview' || !validation.valid) { await log(validation.valid, validation.code || undefined, { query_scope: body.scope || {}, returned_records: body.projects.length, payload_token_estimate: estimateTokens(validation) }); return json(validation, validation.valid ? 200 : 422) }
      const { data: applied, error } = await admin.rpc('apply_work_calendar_state', { p_workspace_id: workspaceId, p_state_name: 'projects', p_expected_revision: body.expectedRevision || null, p_payload: body.projects, p_record_history: true }).single()
      if (error) throw error
      if (applied.status === 'REVISION_MISMATCH') { await log(false, 'REVISION_MISMATCH', { revision: applied.revision }); return json({ error: 'REVISION_MISMATCH', revision: applied.revision }, 409) }
      const existingIds = new Set((existing?.payload || []).map((project: any) => project.id)); const createdProjectCount = body.projects.filter((project: any) => !existingIds.has(project.id)).length
      await log(true, undefined, { revision: applied.revision, returned_records: body.projects.length, payload_token_estimate: estimateTokens(body.projects), created_project_count: createdProjectCount }); return json({ ok: true, revision: applied.revision })
    }
    if (operation === 'apply_staff') {
      if (!body.staff || !Array.isArray(body.staff.managers) || !Array.isArray(body.staff.workers)) { await log(false, 'INVALID_PAYLOAD'); return json({ error: 'INVALID_PAYLOAD' }, 400) }
      const { data: applied, error } = await admin.rpc('apply_work_calendar_state', { p_workspace_id: workspaceId, p_state_name: 'staff', p_expected_revision: body.expectedRevision || null, p_payload: body.staff, p_record_history: false }).single()
      if (error) throw error
      if (applied.status === 'REVISION_MISMATCH') { await log(false, 'REVISION_MISMATCH', { revision: applied.revision }); return json({ error: 'REVISION_MISMATCH', revision: applied.revision }, 409) }
      await log(true, undefined, { revision: applied.revision, returned_records: body.staff.managers.length + body.staff.workers.length }); return json({ ok: true, revision: applied.revision })
    }
    if (operation === 'metrics') { const { data, error } = await admin.from('work_calendar_events').select('actor_channel, operation, success, error_code, duration_ms, payload_token_estimate, created_project_count, created_at').gte('created_at', body.since || new Date(Date.now() - 30 * 86400000).toISOString()); if (error) throw error; await log(true); return json({ events: data }) }
    await log(false, 'UNKNOWN_ACTION'); return json({ error: 'UNKNOWN_ACTION' }, 400)
  } catch (error) { console.error(error); await log(false, 'INTERNAL_ERROR'); return json({ error: 'INTERNAL_ERROR' }, 500) }
})
