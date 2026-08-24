import { createClient } from '@supabase/supabase-js'
import { isDemoMode } from './demoMode'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
const apiUrl = import.meta.env.VITE_WORK_CALENDAR_API_URL || (supabaseUrl ? `${supabaseUrl}/functions/v1/work-calendar` : '')
const cloudEnabled = !isDemoMode && Boolean(supabaseUrl && supabaseAnonKey && apiUrl)
let client
let projectsRevision = null
let staffRevision = null
let capabilities = { role: null, canSchedule: false, canManageRoster: false, canViewMetrics: false }

function getClient() {
  if (!cloudEnabled) return null
  if (!client) client = createClient(supabaseUrl, supabaseAnonKey)
  return client
}

async function post(action, payload = {}, { authenticated = true } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (authenticated) {
    const { data: { session } } = await getClient().auth.getSession()
    if (!session?.access_token) throw new Error('请先通过邮箱链接登录后再使用云端排班。')
    headers.Authorization = `Bearer ${session.access_token}`
  }
  const response = await fetch(apiUrl, { method: 'POST', headers, body: JSON.stringify({ action, ...payload }) })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(result.error || '云端请求失败')
    error.code = result.error
    error.revision = result.revision
    throw error
  }
  return result
}

async function readState() {
  const result = await post('read', { scope: { full: true } })
  projectsRevision = result.revision
  staffRevision = result.staffRevision
  capabilities = result.capabilities || capabilities
  return result
}

function acceptRevision(result) {
  projectsRevision = result.revision
  return result
}

export function isCloudEnabled() { return cloudEnabled }
export function getCloudAuthClient() { return getClient() }
export function getCloudCapabilities() { return capabilities }
export async function requestLoginLink(email) { return post('request_login', { email }, { authenticated: false }) }
export async function loadProjectsFromCloud() { return (await readState())?.projects ?? null }
export async function loadStaffFromCloud() { return (await readState())?.staff ?? null }
export async function createProjectInCloud(project) { return acceptRevision(await post('create_project', { project, expectedRevision: projectsRevision })) }
export async function updateProjectInCloud(project) { return acceptRevision(await post('update_project', { project, expectedRevision: projectsRevision })) }
export async function deleteProjectsInCloud(deleteProjectIds) { return acceptRevision(await post('delete_projects', { deleteProjectIds, expectedRevision: projectsRevision })) }
export async function saveStaffToCloud(staff) {
  const payload = { managers: staff.managers || [], workers: staff.workers || [] }
  const result = await post('apply_staff', { staff: payload, expectedRevision: staffRevision })
  staffRevision = result.revision
  return result
}
export async function previewProjectInCloud(mutation, payload) { return post('preview', { mutation, ...payload, expectedRevision: projectsRevision }) }
export async function loadProjectsSnapshotFromCloud() { return null }
