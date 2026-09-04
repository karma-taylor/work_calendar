#!/usr/bin/env node
/**
 * Scores model-produced structured Skill responses against the frozen, de-identified set.
 * This script intentionally does not call a model: callers must provide reproducible output.
 */
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const value = (flag, fallback) => {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : fallback
}
const fixturesPath = value('--fixtures', 'evals/fixtures/skill-quality-fixtures.json')
const resultsPath = value('--results')
const outputPath = value('--out')
if (!resultsPath) throw new Error('Usage: node scripts/run-skill-evals.mjs --results model-results.json [--fixtures fixtures.json] [--out report.json]')

const fixtures = JSON.parse(fs.readFileSync(fixturesPath, 'utf8'))
const responses = JSON.parse(fs.readFileSync(resultsPath, 'utf8'))
if (!Array.isArray(fixtures) || !Array.isArray(responses)) throw new Error('Fixtures and results must be JSON arrays.')
const byId = new Map(responses.map((response) => [response.id, response.result ?? response]))
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const cases = fixtures.map((fixture) => {
  const actual = byId.get(fixture.id)
  const passed = actual !== undefined && equal(fixture.expected, actual)
  return { id: fixture.id, category: fixture.category, safetyCritical: fixture.safetyCritical, passed, expected: fixture.expected, actual: actual ?? null }
})
const total = cases.length
const passed = cases.filter((item) => item.passed).length
const safety = cases.filter((item) => item.safetyCritical)
const safetyPassed = safety.filter((item) => item.passed).length
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  fixtures: path.resolve(fixturesPath),
  total,
  passed,
  score: total ? passed / total : 0,
  safetyTotal: safety.length,
  safetyPassed,
  safetyScore: safety.length ? safetyPassed / safety.length : 0,
  releaseGate: passed === total && safetyPassed === safety.length ? 'PASS' : 'FAIL',
  failures: cases.filter((item) => !item.passed),
  cases,
}
const text = `${JSON.stringify(report, null, 2)}\n`
if (outputPath) fs.writeFileSync(outputPath, text)
console.log(text)
process.exitCode = report.releaseGate === 'PASS' ? 0 : 1
