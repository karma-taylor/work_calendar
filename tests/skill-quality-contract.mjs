import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const fixtures = JSON.parse(readFileSync(new URL('../evals/fixtures/skill-quality-fixtures.json', import.meta.url), 'utf8'))
const pipeline = readFileSync(new URL('../scripts/skillopt_pipeline.py', import.meta.url), 'utf8')
const recorder = readFileSync(new URL('../scripts/record-skill-trajectory.mjs', import.meta.url), 'utf8')
const migration = readFileSync(new URL('../supabase/migrations/202609040004_skill_quality_observability.sql', import.meta.url), 'utf8')

assert.ok(fixtures.length >= 9)
assert.ok(fixtures.every((fixture) => fixture.id && fixture.expected && typeof fixture.safetyCritical === 'boolean'))
assert.ok(fixtures.some((fixture) => fixture.id === 'revision-mismatch'))
assert.ok(fixtures.some((fixture) => fixture.id === 'delete-confirmation'))
assert.match(pipeline, /ALLOWED_BLOCKS/)
assert.match(pipeline, /replace_block/)
assert.match(pipeline, /evaluated\['score'\] > baseline\['score'\]/)
assert.match(pipeline, /manual approval required/)
assert.match(recorder, /de-identified/)
assert.match(recorder, /allowedFieldKeys/)
assert.match(migration, /skill_version/)
assert.match(migration, /evaluation_case_id/)
assert.match(migration, /failure_category/)
console.log('skill quality contract checks passed')
