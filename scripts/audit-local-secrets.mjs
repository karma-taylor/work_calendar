import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const label = 'work-calendar-staging-deploy'
const tracked = spawnSync('git', ['grep', '-n', '--fixed-strings', label, '--', ':!scripts/audit-local-secrets.mjs'], { encoding: 'utf8' })
const candidateFiles = ['.env', '.env.local', '.env.staging.local']
const references = candidateFiles.filter((file) => existsSync(file) && readFileSync(file, 'utf8').includes(label))

console.log(JSON.stringify({
  tokenLabel: label,
  repositoryReferenceFound: tracked.status === 0,
  localConfigReferenceFiles: references,
  accessTokenPresentInCurrentShell: Boolean(process.env.SUPABASE_ACCESS_TOKEN),
  guidance: 'Revoke the temporary PAT in Supabase Dashboard > Account > Access Tokens. This script never prints token values.',
}, null, 2))

if (tracked.status === 0 || references.length || process.env.SUPABASE_ACCESS_TOKEN) process.exitCode = 1
