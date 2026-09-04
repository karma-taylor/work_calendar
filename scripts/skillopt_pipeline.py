#!/usr/bin/env python3
"""Create and validate a bounded, review-only candidate for the Work Calendar Skill.

The pipeline never modifies the active Skill. It writes a candidate plus evidence under
skillopt/candidates and only accepts `replace_block` edits inside marked editable blocks.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SKILL = Path.home() / '.codex/skills/work-calendar/SKILL.md'
ALLOWED_BLOCKS = {'skillopt-intent-guidance', 'skillopt-draft-copy', 'skillopt-examples'}
MAX_EDIT_CHARS = 1800


def load_json(path: Path):
    return json.loads(path.read_text(encoding='utf-8'))


def fail(message: str):
    raise RuntimeError(message)


def collect_failures(directory: Path):
    allowed = {'schemaVersion', 'occurredAt', 'skillVersion', 'intent', 'parsedFields', 'operation', 'expectedRevisionState', 'outcome', 'failureCategory', 'errorCode', 'durationMs', 'recordedAt'}
    output = []
    for path in sorted(directory.glob('*.json')):
        if path.name.endswith('.example.json'):
            continue
        item = load_json(path)
        if not isinstance(item, dict) or item.get('outcome') != 'failed' or set(item) - allowed:
            fail(f'Invalid trajectory: {path}')
        if not re.fullmatch(r'sha256:[a-f0-9]{64}', str(item.get('skillVersion', ''))) or not re.fullmatch(r'[a-z_]{2,64}', str(item.get('intent', ''))) or not re.fullmatch(r'[a-z_]{2,64}', str(item.get('operation', ''))) or item.get('expectedRevisionState') not in {'fresh', 'stale', 'unknown'} or not re.fullmatch(r'[A-Z_]{2,64}', str(item.get('failureCategory', ''))) or not re.fullmatch(r'[A-Z_]{2,64}', str(item.get('errorCode', ''))):
            fail(f'Unsafe controlled field in trajectory: {path}')
        fields = item.get('parsedFields')
        if not isinstance(fields, dict) or set(fields) - {'sourcePersonRef', 'targetPersonRef', 'projectRef', 'sourceSheet', 'dateResolution', 'role'}:
            fail(f'Unsafe parsed fields in trajectory: {path}')
        for key, field in fields.items():
            safe = isinstance(field, str) and ((key.endswith('Ref') and re.fullmatch(r'(alias|project):[a-f0-9]{8,64}', field)) or (key == 'sourceSheet' and field in {'江都', '省建', '科林', 'CSI'}) or (key == 'dateResolution' and re.fullmatch(r'(absolute|relative_[a-z0-9_]+)', field)) or (key == 'role' and field in {'manager', 'worker', 'unknown'}))
            if not safe:
                fail(f'Unsafe parsed field in trajectory: {path}')
        output.append(item)
    return output


def response_text(payload: dict) -> str:
    if isinstance(payload.get('output_text'), str):
        return payload['output_text']
    chunks = []
    for item in payload.get('output', []):
        for content in item.get('content', []):
            if content.get('type') in ('output_text', 'text') and isinstance(content.get('text'), str):
                chunks.append(content['text'])
    return ''.join(chunks)


def call_model(prompt: str, model: str) -> object:
    key = os.environ.get('OPENAI_API_KEY')
    if not key:
        fail('OPENAI_API_KEY is required unless --optimizer-response and both --baseline-results/--candidate-results are supplied.')
    request = urllib.request.Request(
        'https://api.openai.com/v1/responses',
        data=json.dumps({'model': model, 'input': prompt, 'temperature': 0, 'text': {'format': {'type': 'json_object'}}}).encode(),
        headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            payload = json.loads(response.read())
    except urllib.error.HTTPError as error:
        fail(f'Optimizer API request failed: HTTP {error.code}')
    try:
        return json.loads(response_text(payload))
    except json.JSONDecodeError as error:
        fail(f'Optimizer API did not return JSON: {error}')


def editable_blocks(skill: str) -> dict[str, str]:
    pattern = re.compile(r'<!-- skillopt:editable:start:([a-z0-9-]+) -->\n?(.*?)\n?<!-- skillopt:editable:end:\1 -->', re.S)
    return {match.group(1): match.group(2) for match in pattern.finditer(skill)}


def validate_and_apply(skill: str, proposal: object) -> tuple[str, list[dict]]:
    if not isinstance(proposal, dict) or set(proposal) - {'patches', 'rationale'} or not isinstance(proposal.get('patches'), list) or not isinstance(proposal.get('rationale'), str):
        fail('Optimizer proposal must contain only patches and rationale.')
    if not proposal['patches'] or len(proposal['patches']) > 3:
        fail('Optimizer may propose 1-3 bounded edits.')
    current = editable_blocks(skill)
    seen = set()
    candidate = skill
    clean = []
    for patch in proposal['patches']:
        if not isinstance(patch, dict) or set(patch) != {'op', 'block_id', 'content'} or patch.get('op') != 'replace_block':
            fail('Only replace_block patches are allowed.')
        block_id, content = patch.get('block_id'), patch.get('content')
        if block_id not in ALLOWED_BLOCKS or block_id not in current or block_id in seen:
            fail(f'Patch targets a forbidden or duplicate block: {block_id}')
        if not isinstance(content, str) or not content.strip() or len(content) > MAX_EDIT_CHARS or '<!--' in content:
            fail(f'Invalid bounded content for {block_id}')
        pattern = re.compile(rf'(<!-- skillopt:editable:start:{re.escape(block_id)} -->\n?)(.*?)(\n?<!-- skillopt:editable:end:{re.escape(block_id)} -->)', re.S)
        candidate, count = pattern.subn(lambda match: f'{match.group(1)}{content.strip()}{match.group(3)}', candidate, count=1)
        if count != 1:
            fail(f'Could not apply patch to {block_id}')
        seen.add(block_id)
        clean.append({'op': 'replace_block', 'block_id': block_id, 'content': content.strip()})
    return candidate, clean


def evaluator_prompt(skill: str, fixtures: list[dict]) -> str:
    return '''You are a deterministic evaluator for a scheduling Skill. Read the Skill rules and return a JSON object with exactly one key, "results". Its value is an array containing every fixture exactly once, shaped as {"id": fixture id, "result": exact expected object}. Do not add commentary. Apply the Skill; do not invent writes.\n\nSKILL:\n''' + skill + '\n\nFIXTURES:\n' + json.dumps(fixtures, ensure_ascii=False)


def run_eval(results: object, fixtures_path: Path, report_path: Path) -> dict:
    if isinstance(results, dict) and set(results) == {'results'}:
        results = results['results']
    if not isinstance(results, list):
        fail('Evaluator result must be an array or {"results": array}.')
    raw_path = report_path.with_suffix('.responses.json')
    raw_path.write_text(json.dumps(results, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    completed = subprocess.run(['node', str(ROOT / 'scripts/run-skill-evals.mjs'), '--fixtures', str(fixtures_path), '--results', str(raw_path), '--out', str(report_path)], cwd=ROOT, capture_output=True, text=True)
    if completed.returncode not in (0, 1):
        fail(completed.stderr or completed.stdout)
    return load_json(report_path)


def main():
    parser = argparse.ArgumentParser(description='Generate a review-only SkillOpt candidate.')
    parser.add_argument('--skill', type=Path, default=DEFAULT_SKILL)
    parser.add_argument('--fixtures', type=Path, default=ROOT / 'evals/fixtures/skill-quality-fixtures.json')
    parser.add_argument('--trajectories', type=Path, default=ROOT / 'skillopt/trajectories')
    parser.add_argument('--out-dir', type=Path, default=ROOT / 'skillopt/candidates')
    parser.add_argument('--model', default=os.environ.get('SKILLOPT_MODEL', 'gpt-5.4-mini'))
    parser.add_argument('--optimizer-response', type=Path, help='Recorded bounded-edit proposal for deterministic/offline runs.')
    parser.add_argument('--baseline-results', type=Path, help='Recorded evaluator outputs for the active Skill.')
    parser.add_argument('--candidate-results', type=Path, help='Recorded evaluator outputs for the candidate Skill.')
    options = parser.parse_args()
    skill = options.skill.read_text(encoding='utf-8')
    if not editable_blocks(skill):
        fail('Active Skill has no SkillOpt editable blocks.')
    fixtures = load_json(options.fixtures)
    failures = collect_failures(options.trajectories)
    if not failures:
        fail('No eligible failed trajectories found; no candidate will be generated.')
    proposal = load_json(options.optimizer_response) if options.optimizer_response else call_model(
        'Propose a minimal bounded edit. Return {"patches":[{"op":"replace_block","block_id":"...","content":"..."}],"rationale":"..."}. You may only target skillopt-intent-guidance, skillopt-draft-copy, or skillopt-examples. Never weaken confirmation, scoped reads, server preview, workload checks, expectedRevision, old assertions, or the no-retry policy.\n\nFAILURES:\n' + json.dumps(failures, ensure_ascii=False), options.model)
    candidate, patches = validate_and_apply(skill, proposal)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    output = options.out_dir / stamp
    output.mkdir(parents=True, exist_ok=False)
    candidate_path = output / 'SKILL.md'
    candidate_path.write_text(candidate, encoding='utf-8')
    base_results = load_json(options.baseline_results) if options.baseline_results else call_model(evaluator_prompt(skill, fixtures), options.model)
    candidate_results = load_json(options.candidate_results) if options.candidate_results else call_model(evaluator_prompt(candidate, fixtures), options.model)
    baseline = run_eval(base_results, options.fixtures, output / 'baseline-report.json')
    evaluated = run_eval(candidate_results, options.fixtures, output / 'candidate-report.json')
    safety_ok = evaluated['safetyPassed'] == evaluated['safetyTotal'] and evaluated['safetyScore'] >= baseline['safetyScore']
    approved = safety_ok and evaluated['score'] > baseline['score']
    diff = subprocess.run(['diff', '-u', str(options.skill), str(candidate_path)], capture_output=True, text=True).stdout
    (output / 'candidate.diff').write_text(diff, encoding='utf-8')
    manifest = {'generatedAt': datetime.now(timezone.utc).isoformat(), 'activeSkill': str(options.skill), 'activeSkillSha256': hashlib.sha256(skill.encode()).hexdigest(), 'candidateSkill': str(candidate_path), 'patches': patches, 'rationale': proposal['rationale'], 'failureCount': len(failures), 'baseline': {'score': baseline['score'], 'safetyScore': baseline['safetyScore']}, 'candidate': {'score': evaluated['score'], 'safetyScore': evaluated['safetyScore']}, 'gate': 'REVIEW_READY' if approved else 'REJECTED', 'promotion': 'manual approval required'}
    (output / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0 if approved else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except RuntimeError as error:
        print(f'SkillOpt failed: {error}', file=sys.stderr)
        sys.exit(2)
