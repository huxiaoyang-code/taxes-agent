"""The same finance adapter through a measured Linux namespace, not Windows interop."""
import json
import re
import hashlib
from dataclasses import replace
from pathlib import Path
from finance_adapter import FinanceAdapter, read_surface
from sandbox import LinuxSandbox


class LinuxFinanceAdapter(FinanceAdapter):
    def __init__(self, *, sandbox: LinuxSandbox, root: Path, canary: Path,
                 host: str = 'pi', package_root: str = '/host/node_modules/@earendil-works/pi-coding-agent',
                 cli_path: str | None = None, execution_mode: str = 'synthetic-native'):
        self.sandbox, self.canary = sandbox, canary
        if not root.resolve().is_relative_to(sandbox.work.resolve()):
            raise ValueError('harness2_experiment_outside_sandbox_work')
        self.sandbox_root = '/work/' + str(root.resolve().relative_to(sandbox.work.resolve()))
        super().__init__(root=root, repo=sandbox.repo_stage, node=sandbox.node,
            host=host, package_root=package_root, cli_path=cli_path, execution_mode=execution_mode)

    def prepare(self):
        verified = self.sandbox.verify(self.canary)
        result = self.sandbox.run(['/runtime/node', '/repo/06-workbench/scripts/harness2-run.mjs',
            '--host', self.host, '--harness-improvement', 'harness2', '--prepare', '--root', self.sandbox_root], timeout=60)
        if result.returncode:
            raise RuntimeError('harness2_linux_prepare_failed:' + result.stdout.decode()[:200])
        return verified

    def bridge(self, action, run_id, harness_dir=None, timeout=60):
        if not re.fullmatch(r'[-a-zA-Z0-9_]{1,80}', run_id):
            raise ValueError('harness2_run_id_invalid')
        # Actual canary verification is repeated before every execution, not
        # trusted from a user-entered "verified" flag or stale manifest.
        self.sandbox.verify(self.canary)
        request = {'version':'finance-harness2-request/1','action':action,'host':self.host,
            'root':self.sandbox_root,'runId':run_id,'executionMode':self.execution_mode,
            'packageRoot':self.package_root,'timeoutMs':min(timeout*1000,120000)}
        if self.cli_path:
            request['cliPath']=self.cli_path
        if harness_dir:
            read_surface(harness_dir)
            if not harness_dir.resolve().is_relative_to(self.sandbox.work.resolve()):
                raise ValueError('harness2_candidate_outside_sandbox')
            request['candidateDir']='/work/'+str(harness_dir.resolve().relative_to(self.sandbox.work.resolve()))
        path=self.root / ('request-'+run_id+'.json')
        path.write_text(json.dumps(request),encoding='utf-8')
        inside='/work/'+str(path.relative_to(self.sandbox.work.resolve()))
        script='harness2-sandbox-supervisor.mjs' if self.execution_mode=='model' and action=='execute' else 'harness2-bridge.mjs'
        result=self.sandbox.run(['/runtime/node','/repo/06-workbench/scripts/'+script,inside],timeout=timeout+20)
        try:
            value=json.loads(result.stdout)
        except ValueError:
            raise RuntimeError('harness2_linux_bridge_protocol_invalid') from None
        if result.returncode:
            raise RuntimeError(value.get('code','harness2_linux_bridge_failed'))
        return value

    def score(self,run_dir,task_id):
        self.task_prompt(task_id)
        script=Path(__file__).resolve().parents[3]/'06-workbench/scripts/harness2-assess.mjs'
        trusted=replace(self.sandbox,gateway_socket=None,assessment_script=script)
        inside='/work/'+str(run_dir.resolve().relative_to(self.sandbox.work.resolve()))
        result=trusted.run(['/runtime/node','/trusted/assess.mjs',inside],timeout=30)
        if result.returncode:
            return None
        value=json.loads(result.stdout)
        value['assessmentCodeDigest']=hashlib.sha256(script.read_bytes()).hexdigest()
        return value
