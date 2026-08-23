import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
const workspaceId = import.meta.env.VITE_APP_WORKSPACE_ID || 'default'
const apiUrl = import.meta.env.VITE_WORK_CALENDAR_API_URL || (supabaseUrl ? `${supabaseUrl}/functions/v1/work-calendar` : '')
const cloudEnabled = Boolean(supabaseUrl && supabaseAnonKey && apiUrl)
let client
let projectsRevision = null
let staffRevision = null

function getClient() {
  if (!cloudEnabled) return null
  if (!client) client = createClient(supabaseUrl, supabaseAnonKey)
  return client
}

async function callApi(action, payload = {}) {
  const supabase = getClient()
  if (!supabase) return null
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error('请先通过邮箱链接登录后再使用云端排班。')
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ action, workspaceId, actorChannel: 'web', ...payload }),
  })
  const result = await response.json()
  if (!response.ok) {
    const error = new Error(result.error || '云端请求失败')
    error.code = result.error
    error.revision = result.revision
    throw error
  }
  return result
}

async function readState() {
  const result = await callApi('read', { scope: { full: true } })
  projectsRevision = result.revision
  staffRevision = result.staffRevision
  return result
}

export function isCloudEnabled() { return cloudEnabled }
export function getCloudAuthClient() { return getClient() }
export async function loadProjectsFromCloud() { return (await readState())?.projects ?? null }
export async function loadStaffFromCloud() { return (await readState())?.staff ?? null }
export async function saveProjectsToCloud(projects) {
  const result = await callApi('apply', { projects, expectedRevision: projectsRevision })
  projectsRevision = result.revision
}
export async function saveStaffToCloud(staff) {
  const result = await callApi('apply_staff', { staff, expectedRevision: staffRevision })
  staffRevision = result.revision
}
export async function previewProjectsInCloud(projects) { return callApi('preview', { projects, expectedRevision: projectsRevision }) }
export async function loadProjectsSnapshotFromCloud() { return null }
