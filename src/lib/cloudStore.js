import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
const workspaceId = import.meta.env.VITE_APP_WORKSPACE_ID || 'default'
const tableName = import.meta.env.VITE_SUPABASE_TABLE || 'app_state'

const cloudEnabled = Boolean(supabaseUrl && supabaseAnonKey)
let client

function getClient() {
  if (!cloudEnabled) {
    return null
  }
  if (!client) {
    client = createClient(supabaseUrl, supabaseAnonKey)
  }
  return client
}

function scopedKey(name) {
  return `${workspaceId}:${name}`
}

async function loadJson(name) {
  const supabase = getClient()
  if (!supabase) {
    return null
  }
  const { data, error } = await supabase
    .from(tableName)
    .select('payload')
    .eq('id', scopedKey(name))
    .maybeSingle()
  if (error) {
    throw error
  }
  return data?.payload ?? null
}

async function saveJson(name, payload) {
  const supabase = getClient()
  if (!supabase) {
    return
  }
  const { error } = await supabase.from(tableName).upsert(
    {
      id: scopedKey(name),
      payload,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' },
  )
  if (error) {
    throw error
  }
}

export function isCloudEnabled() {
  return cloudEnabled
}

export async function loadProjectsFromCloud() {
  return loadJson('projects')
}

export async function saveProjectsToCloud(projects) {
  return saveJson('projects', projects)
}

export async function loadStaffFromCloud() {
  return loadJson('staff')
}

export async function saveStaffToCloud(staffPayload) {
  return saveJson('staff', staffPayload)
}
