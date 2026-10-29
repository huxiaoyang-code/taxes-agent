"""Linux namespace runner. No Windows interop, inherited credentials or host network.

The executable mounts are deliberately Linux system runtimes only. Project/host
trees must be staged separately without databases, homes, git state or symlinks.
Paid-model routing requires a separate Unix-socket budget gateway; network is
never shared with the caller to make an API request work.
"""
from __future__ import annotations
import json
import os
import signal
import stat
import selectors
import time
import subprocess
from dataclasses import dataclass
from pathlib import Path


def plain_tree(root: Path) -> Path:
    if root.is_symlink() or not root.is_dir():
        raise RuntimeError('harness2_sandbox_plain_directory_required')
    for path in root.rglob('*'):
        if path.is_symlink() or (path.is_file() and path.stat().st_nlink != 1):
            raise RuntimeError('harness2_sandbox_link_forbidden')
        if path.name in ('.git', '.agent-runs', 'workbench.db', 'auth.json', 'credentials.json'):
            raise RuntimeError('harness2_sandbox_sensitive_file_forbidden')
    return root.resolve()


@dataclass
class LinuxSandbox:
    work: Path
    repo_stage: Path | None = None
    host_stage: Path | None = None
    node: Path | None = None
    gateway_socket: Path | None = None
    assessment_script: Path | None = None
    bwrap: Path = Path('/usr/bin/bwrap')

    def command(self, argv: list[str]) -> list[str]:
        if os.name != 'posix' or not self.bwrap.is_file():
            raise RuntimeError('harness2_linux_bwrap_required')
        if not self.work.is_dir() or self.work.is_symlink():
            raise RuntimeError('harness2_sandbox_work_required')
        command = [str(self.bwrap), '--unshare-all', '--die-with-parent', '--new-session',
            '--clearenv', '--setenv', 'PATH', '/runtime:/usr/bin:/bin',
            '--setenv', 'HOME', '/tmp/home', '--setenv', 'TMPDIR', '/tmp',
            '--setenv', 'NODE_NO_WARNINGS', '1', '--ro-bind', '/usr', '/usr',
            '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
            '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
            '--dir', '/tmp/home', '--bind', str(self.work.resolve()), '/work', '--chdir', '/work']
        if self.repo_stage:
            command += ['--ro-bind', str(plain_tree(self.repo_stage)), '/repo']
        if self.host_stage:
            command += ['--ro-bind', str(plain_tree(self.host_stage)), '/host']
        if self.node:
            with self.node.open('rb') as stream:
                magic = stream.read(4)
            if self.node.is_symlink() or magic != b'\x7fELF':
                raise RuntimeError('harness2_linux_elf_runtime_required')
            command += ['--dir', '/runtime', '--ro-bind', str(self.node.resolve()), '/runtime/node']
        if self.gateway_socket:
            if self.gateway_socket.resolve().is_relative_to(self.work.resolve()):
                raise RuntimeError('harness2_budget_socket_must_be_outside_work')
            if not stat.S_ISSOCK(self.gateway_socket.stat().st_mode):
                raise RuntimeError('harness2_budget_unix_socket_required')
            command += ['--dir','/run','--ro-bind',str(self.gateway_socket.resolve()),'/run/finance-gateway.sock']
        if self.assessment_script:
            if self.assessment_script.is_symlink() or not self.assessment_script.is_file():
                raise RuntimeError('harness2_trusted_assessor_invalid')
            command += ['--dir','/trusted','--ro-bind',str(self.assessment_script.resolve()),'/trusted/assess.mjs',
                '--setenv','FINANCE_HARNESS2_ASSESS_REPO','/repo']
        if not argv or not argv[0].startswith(('/usr/', '/runtime/')):
            raise RuntimeError('harness2_sandbox_runtime_command_required')
        if any('.exe' in value.lower() for value in argv):
            raise RuntimeError('harness2_windows_interop_forbidden')
        return command + ['--'] + argv

    def run(self, argv: list[str], *, timeout: int | None = 30,
            output_limit: int | None = None) -> subprocess.CompletedProcess:
        if output_limit is not None and (type(output_limit) is not int or output_limit < 1):
            raise ValueError('harness2_sandbox_output_limit_invalid')
        if timeout is not None and (type(timeout) not in (int, float) or timeout <= 0):
            raise ValueError('harness2_sandbox_timeout_invalid')
        command = self.command(argv)
        proc = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, env={'PATH': '/usr/bin:/bin'}, start_new_session=True)
        selector = selectors.DefaultSelector()
        selector.register(proc.stdout, selectors.EVENT_READ, 'stdout')
        selector.register(proc.stderr, selectors.EVENT_READ, 'stderr')
        chunks = {'stdout': bytearray(), 'stderr': bytearray()}
        deadline = None if timeout is None else time.monotonic() + timeout
        try:
            while selector.get_map():
                remaining = None if deadline is None else deadline - time.monotonic()
                if remaining is not None and remaining <= 0:
                    raise subprocess.TimeoutExpired(command, timeout)
                for key, _ in selector.select(0.1 if remaining is None else min(remaining, 0.1)):
                    data = os.read(key.fileobj.fileno(), 65536)
                    if not data:
                        selector.unregister(key.fileobj)
                    else:
                        chunks[key.data].extend(data)
                        if output_limit is not None and sum(len(v) for v in chunks.values()) > output_limit:
                            raise RuntimeError('harness2_sandbox_output_limit')
            proc.wait(timeout=None if deadline is None else max(0.001, deadline-time.monotonic()))
        except BaseException:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.communicate()
            raise
        finally:
            selector.close()
        return subprocess.CompletedProcess(command, proc.returncode, bytes(chunks['stdout']), bytes(chunks['stderr']))

    def verify(self, canary: Path) -> dict:
        if not canary.is_file() or canary.is_relative_to(self.work):
            raise RuntimeError('harness2_external_canary_required')
        # Canary path and its parent must not be mounted; no success boolean is
        # accepted from configuration. Network tests happen in the real namespace.
        script = r'''import json, os, socket, sys
p=sys.argv[1]
assert not os.path.exists(p), 'external_canary_visible'
assert not os.path.exists('/mnt/d'), 'host_mount_visible'
assert not os.path.exists('/home'), 'host_home_visible'
assert not os.path.exists('/proc/sys/fs/binfmt_misc/WSLInterop'), 'windows_interop_visible'
assert not os.path.exists('/repo/06-workbench/scripts/harness2-assess.mjs'), 'independent_assessor_visible'
assert not os.path.exists('/repo/06-workbench/scripts/harness2-finalize.mjs'), 'independent_expectation_visible'
assert not os.path.exists('/trusted'), 'trusted_assessment_mount_visible'
s=socket.socket(); s.settimeout(1)
try:
 s.connect(('1.1.1.1',443))
except OSError:
 pass
else:
 raise AssertionError('external_network_visible')
assert not any(k.endswith(('API_KEY','AUTH_TOKEN')) for k in os.environ)
print(json.dumps({'filesystemCanaryHidden':True,'hostMountHidden':True,'windowsInteropHidden':True,'independentAssessorHidden':True,'externalNetworkDenied':True,'credentialsAbsent':True}))
'''
        result = self.run(['/usr/bin/python3.12', '-I', '-c', script, str(canary.resolve())])
        if result.returncode:
            raise RuntimeError('harness2_sandbox_canary_failed')
        return json.loads(result.stdout)
