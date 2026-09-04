#!/usr/bin/env python3
"""Manually promote a previously gated candidate and preserve an active-Skill rollback copy."""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SKILL = Path.home() / '.codex/skills/work-calendar/SKILL.md'

parser = argparse.ArgumentParser(description='Promote a REVIEW_READY SkillOpt candidate after human approval.')
parser.add_argument('--candidate-dir', type=Path, required=True)
parser.add_argument('--skill', type=Path, default=DEFAULT_SKILL)
parser.add_argument('--approve', action='store_true', help='Required: confirms human review.')
args = parser.parse_args()
if not args.approve:
    raise SystemExit('Refusing promotion without --approve.')
manifest = json.loads((args.candidate_dir / 'manifest.json').read_text(encoding='utf-8'))
if manifest.get('gate') != 'REVIEW_READY':
    raise SystemExit('Refusing promotion: candidate did not pass the validation gate.')
current = args.skill.read_text(encoding='utf-8')
current_hash = hashlib.sha256(current.encode()).hexdigest()
if current_hash != manifest.get('activeSkillSha256'):
    raise SystemExit('Refusing promotion: active Skill changed after candidate generation. Re-run evaluation.')
history = args.skill.parent / '.history'
history.mkdir(exist_ok=True)
stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup = history / f'work-calendar-{stamp}-{current_hash[:12]}.md'
shutil.copy2(args.skill, backup)
shutil.copy2(args.candidate_dir / 'SKILL.md', args.skill)
record = {'promotedAt': datetime.now(timezone.utc).isoformat(), 'skillVersion': hashlib.sha256(args.skill.read_bytes()).hexdigest(), 'rollbackPath': str(backup), 'candidateDir': str(args.candidate_dir), 'baseline': manifest['baseline'], 'candidate': manifest['candidate'], 'rationale': manifest['rationale']}
log = ROOT / 'skillopt/release-log.jsonl'
with log.open('a', encoding='utf-8') as file:
    file.write(json.dumps(record, ensure_ascii=False) + '\n')
print(json.dumps(record, ensure_ascii=False, indent=2))
