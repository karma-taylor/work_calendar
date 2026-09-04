#!/usr/bin/env node
/** Save a narrowly-scoped, de-identified Skill failure trajectory. */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const [inputPath, outputDir = 'skillopt/trajectories'] = process.argv.slice(2)
if (!inputPath) throw new Error('Usage: node scripts/record-skill-trajectory.mjs input.json [output-dir]')
const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
const allowed = new Set(['schemaVersion', 'occurredAt', 'skillVersion', 'intent', 'parsedFields', 'operation', 'expectedRevisionState', 'outcome', 'failureCategory', 'errorCode', 'durationMs'])
for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`Unsupported trajectory field: ${key}`)
if (input.outcome !== 'failed') throw new Error('Only failed trajectories are eligible for SkillOpt.')
if (!Number.isInteger(input.durationMs) || input.durationMs < 0) throw new Error('durationMs must be a non-negative integer.')
if (input.schemaVersion !== 1 || !/^sha256:[a-f0-9]{64}$/.test(input.skillVersion || '') || !/^[a-z_]{2,64}$/.test(input.intent || '') || !/^[a-z_]{2,64}$/.test(input.operation || '') || !['fresh', 'stale', 'unknown'].includes(input.expectedRevisionState) || !/^[A-Z_]{2,64}$/.test(input.failureCategory || '') || !/^[A-Z_]{2,64}$/.test(input.errorCode || '')) throw new Error('Trajectory has an invalid controlled field.')
const allowedFieldKeys = new Set(['sourcePersonRef', 'targetPersonRef', 'projectRef', 'sourceSheet', 'dateResolution', 'role'])
if (!input.parsedFields || typeof input.parsedFields !== 'object' || Array.isArray(input.parsedFields)) throw new Error('parsedFields must be an object.')
for (const [key, field] of Object.entries(input.parsedFields)) {
  if (!allowedFieldKeys.has(key) || typeof field !== 'string') throw new Error(`Unsupported parsed field: ${key}`)
  const safe = (key.endsWith('Ref') && /^(alias|project):[a-f0-9]{8,64}$/.test(field)) || (key === 'sourceSheet' && ['江都', '省建', '科林', 'CSI'].includes(field)) || (key === 'dateResolution' && /^(absolute|relative_[a-z0-9_]+)$/.test(field)) || (key === 'role' && ['manager', 'worker', 'unknown'].includes(field))
  if (!safe) throw new Error(`parsedFields.${key} is not de-identified.`)
}
fs.mkdirSync(outputDir, { recursive: true })
const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`
const target = path.join(outputDir, `${id}.json`)
fs.writeFileSync(target, `${JSON.stringify({ ...input, recordedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 })
console.log(target)
