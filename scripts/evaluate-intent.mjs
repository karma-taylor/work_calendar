// Compare model-produced structured results with the frozen core instruction set.
import fs from 'node:fs'
const [expectedPath, actualPath] = process.argv.slice(2)
if (!expectedPath || !actualPath) throw new Error('Usage: node scripts/evaluate-intent.mjs tests/accuracy-fixtures.json results.json')
const expected = JSON.parse(fs.readFileSync(expectedPath)); const actual = JSON.parse(fs.readFileSync(actualPath))
if (!Array.isArray(actual) || actual.length !== expected.length) throw new Error('Result count must match fixture count.')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const passed = expected.filter((fixture, index) => same(fixture.expected, actual[index].expected ?? actual[index])).length
console.log(JSON.stringify({ total: expected.length, passed, accuracy: passed / expected.length, releaseGate: passed === expected.length ? 'PASS' : 'FAIL' }, null, 2))
process.exitCode = passed === expected.length ? 0 : 1
