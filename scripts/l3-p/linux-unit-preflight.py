"""Read-only eligibility guard, not a BPF runtime test or an authorization grant."""
import json
import re
import subprocess
import sys

sys.dont_write_bytecode = True


def check_build(version, platform):
    if platform != 'linux':
        return {'status': 'BLOCKED', 'reason': 'linux-required'}
    token = re.search(r'(?<!\S)([+-])BPF_FRAMEWORK(?!\S)', version)
    if not token or token.group(1) != '+':
        return {'status': 'BLOCKED', 'reason': 'socket-bind-bpf-framework-required',
                'runtimeEnforcement': 'NOT_RUN'}
    return {'status': 'ELIGIBLE_FOR_RUNTIME_CHECK', 'runtimeEnforcement': 'NOT_RUN',
            'permission': 'No resource creation or service start is authorized by this check.'}


def main():
    try:
        result = subprocess.run(['/usr/bin/systemd-analyze', '--version'],
            capture_output=True, text=True, timeout=3, check=True,
            env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'})
        output = check_build(result.stdout, sys.platform)
    except (OSError, subprocess.SubprocessError):
        output = {'status': 'BLOCKED', 'reason': 'systemd-build-unavailable'}
    print(json.dumps(output))
    return 0 if output['status'] == 'ELIGIBLE_FOR_RUNTIME_CHECK' else 2


if __name__ == '__main__':
    raise SystemExit(main())
