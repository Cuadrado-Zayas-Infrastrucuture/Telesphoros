"""Audit fixed synthetic strings; never execute the Git commands in them."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

SOURCE_SHA256 = '234922b83c0a1737ee7300806c21ac0f389b07aaeb65c2d71ccedafbc5e1ea4b'
CASES = (
    ('status', 'git status', 'allow'),
    ('push', 'git push origin main', 'block'),
    ('hard-reset', 'git reset --hard HEAD', 'block'),
    ('git-options', 'git -C /synthetic/repo push origin main', 'block'),
    ('clean-combined', 'git clean -xdf', 'block'),
    ('restore-options', 'git restore --worktree -- .', 'block'),
    ('quoted-text', 'printf "%s" "git push"', 'allow'),
    ('malformed-json', None, 'block'),
    ('missing-jq', 'git push origin main', 'block'),
)


def audit():
    agents = Path(__file__).resolve().parents[3]
    script = agents / 'vendor/mattpocock/git-guardrails-claude-code/scripts/block-dangerous-git.sh'
    if hashlib.sha256(script.read_bytes()).hexdigest() != SOURCE_SHA256:
        raise ValueError('Reference source changed; review before running it.')
    if not Path('/bin/bash').is_file() or not shutil.which('jq'):
        raise ValueError('The offline audit requires bash and jq.')
    results = []
    with tempfile.TemporaryDirectory(prefix='git-guardrail-audit-') as directory:
        # Only the dependency-failure probe uses this PATH. No candidate payload runs.
        for executable in ('cat', 'grep'):
            target = shutil.which(executable)
            if not target:
                raise ValueError('A required audit dependency is unavailable.')
            (Path(directory) / executable).symlink_to(target)
        for name, command, intended in CASES:
            payload = '{' if name == 'malformed-json' else json.dumps({'tool_input': {'command': command}})
            env = {'PATH': directory if name == 'missing-jq' else os.environ.get('PATH', ''), 'LC_ALL': 'C'}
            producer = subprocess.run(
                ['/bin/bash', str(script)], input=payload.encode(), capture_output=True,
                env=env, timeout=10, check=False,
            )
            observed = {0: 'allow', 2: 'block'}.get(producer.returncode, 'error')
            results.append({
                'id': name, 'command': command, 'intended_sample_policy': intended,
                'observed': observed, 'producer_exit': producer.returncode,
                'meets_policy': intended == observed,
                'producer_stdout': producer.stdout.decode(errors='replace'),
                'producer_stderr': producer.stderr.decode(errors='replace'),
            })
    matched = sum(item['meets_policy'] for item in results)
    print(json.dumps({
        'reference_sha256': SOURCE_SHA256, 'matched': matched, 'total': len(results),
        'policy_gaps': len(results) - matched, 'payload_commands_executed': False,
        'host_interception_tested': False, 'sample_policy_adopted': False, 'cases': results,
    }, indent=2))
    return 0 if matched == len(results) else 1


if __name__ == '__main__':
    try:
        sys.exit(audit())
    except (OSError, ValueError, subprocess.TimeoutExpired):
        print(json.dumps({'status': 'audit unavailable', 'policy_acceptance': False}), file=sys.stderr)
        sys.exit(2)
