"""Codex editor channel, separate from the native solver's model gateway.

Codex CLI uses the operator's saved authentication and default model. A trusted
outer-host worker receives only explicit synthetic context and returns Markdown
bytes; candidate namespaces never receive Codex credentials or Windows interop.
"""
import hashlib
import json
import os
import re
import signal
import subprocess
import threading
from pathlib import Path
from harness2.core.proposer import Reply, ProposerError
from finance_adapter import FILES, validate, read_surface, windows_path


class CodexIntegrationError(RuntimeError):
    """Fatal optimizer IO/protocol failure, never a recoverable candidate rejection."""


def classify_reflection(reply, experience):
    """Distinguish an explicit upstream NO_ENTRY from missing/malformed output."""
    if not isinstance(reply,str) or not reply.strip():
        raise CodexIntegrationError('harness2_reflection_incomplete')
    if experience:
        if not isinstance(experience,dict) or not all(isinstance(experience.get(key),str) and experience[key].strip() for key in ('cue','lesson','evidence')) or re.search(r'(?m)^\s*NO_ENTRY\s*$',reply):
            raise CodexIntegrationError('harness2_reflection_incomplete')
        return 'recorded'
    no_entry=re.fullmatch(r'\s*(?:<edits>(?P<edits>.*?)</edits>\s*)?NO_ENTRY\s*',reply,re.S)
    if no_entry and (no_entry.group('edits') is None or no_entry.group('edits').strip()) and reply.count('<edits>')==reply.count('</edits>')<=1 and not re.search(r'</?experience\b',reply):
        return 'no_entry'
    raise CodexIntegrationError('harness2_reflection_incomplete')


def launch_path(value):
    value=str(value)
    if os.name!='nt' and re.match(r'^[A-Za-z]:[/\\]',value):
        return '/mnt/'+value[0].lower()+'/'+value[3:].replace('\\','/')
    return value


class CodexProposer:
    def __init__(self, *, experiment: Path, codex_cli: str, node: str,
                 work_root: str, worker: Path | None = None,
                 timeout_ms: int | None = None, codex_script: str | None = None):
        self.experiment=experiment.resolve()
        self.codex_cli,self.node,self.work_root=codex_cli,node,work_root
        self.worker=worker or Path(__file__).with_name('codex-proposer-worker.mjs')
        self.timeout_ms=timeout_ms
        self.codex_script=codex_script
        self.invocations=[]
        self.replies={}
        self._failure=None
        self._call_lock=threading.Lock()

    def _record(self, label, metadata):
        self.invocations.append(metadata)
        audit=self.experiment/'codex-invocations';audit.mkdir(exist_ok=True)
        (audit/(hashlib.sha256(label.encode()).hexdigest()+'.json')).write_text(json.dumps(metadata,indent=2))

    def call(self, mission, context_dir, label, *, harvest=None, max_attempts=1):
        # Google 可能已排队更多提案任务；此优化器连接一旦失败，
        # 所有任务均不得再启动 CLI，也不得回退到求解器。
        with self._call_lock:
            if self._failure is not None:raise CodexIntegrationError(self._failure)
            try:return self._call(mission,context_dir,label,harvest=harvest)
            except CodexIntegrationError as error:
                self._failure=str(error)
                raise

    def _call(self, mission, context_dir, label, *, harvest=None):
        root=Path(context_dir).resolve()
        if not root.is_relative_to(self.experiment):
            raise ProposerError('harness2_context_outside_experiment')
        evidence={}
        for path in sorted(root.rglob('*')):
            if path.is_symlink():
                raise ProposerError('harness2_context_symlink_forbidden')
            if path.is_file():
                if path.suffix not in ('.md','.json','.txt','.diff'):
                    raise ProposerError('harness2_context_binary_forbidden')
                evidence[str(path.relative_to(root)).replace('\\','/')]=path.read_text(encoding='utf-8')
        request={'version':'finance-codex-proposer/1','label':label,'mission':mission,
            'syntheticFiles':evidence,'harvest':bool(harvest),'codexCli':self.codex_cli,
            'workRoot':self.work_root}
        if self.timeout_ms is not None:request['timeoutMs']=self.timeout_ms
        if self.codex_script is not None:request['codexScript']=self.codex_script
        worker=windows_path(self.worker) if os.name!='nt' and str(self.node).lower().endswith('.exe') else str(self.worker)
        try:
            proc=subprocess.Popen([launch_path(self.node),worker],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=os.name!='nt')
        except OSError:
            self._record(label,{'label':label,'status':'worker_transport_failed','exitCode':None})
            raise CodexIntegrationError('harness2_codex_worker_transport_failed') from None
        input_stream=proc.stdin
        try:
            # 保持输入管道持续打开，使外层 worker 能观察父进程取消；
            # Codex 退出前，communicate() 不能关闭该管道。
            input_stream.write((json.dumps(request,ensure_ascii=False)+'\n').encode());input_stream.flush();proc.stdin=None
            stdout,stderr=proc.communicate(timeout=None if self.timeout_ms is None else self.timeout_ms/1000+10)
        except (OSError,subprocess.TimeoutExpired):
            try:input_stream.close()
            except OSError:pass
            try:proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                if os.name!='nt':
                    try:os.killpg(proc.pid,signal.SIGKILL)
                    except ProcessLookupError:pass
                else:proc.kill()
                proc.wait()
            self._record(label,{'label':label,'status':'worker_transport_failed','exitCode':proc.returncode})
            raise CodexIntegrationError('harness2_codex_worker_transport_failed') from None
        finally:
            if not input_stream.closed:
                try:input_stream.close()
                except OSError:pass
        try:
            response=json.loads(stdout)
            if not isinstance(response,dict) or not isinstance(response.get('metadata',{}),dict):raise ValueError()
        except (ValueError,TypeError):
            self._record(label,{'label':label,'status':'worker_protocol_failed','exitCode':proc.returncode})
            raise CodexIntegrationError('harness2_codex_worker_protocol_failed') from None
        code=response.get('code','codex_worker_failed')
        if not isinstance(code,str) or not re.fullmatch('[a-z_]+',code):code='codex_worker_failed'
        metadata=response.get('metadata') or {'label':label,'status':code,'exitCode':proc.returncode}
        self._record(label,metadata)
        if proc.returncode or not response.get('ok'):
            raise CodexIntegrationError('harness2_'+code)
        reply=response.get('reply');edits=response.get('files',{})
        if not isinstance(reply,str) or not reply.strip() or not isinstance(edits,dict) or set(edits)-FILES or not all(isinstance(v,str) for v in edits.values()):
            raise CodexIntegrationError('harness2_codex_answer_invalid')
        workspace=None
        if harvest:
            current=read_surface(root/'harness');current.update(edits);validate(current)
            destination=self.experiment/'codex-guidance'/hashlib.sha256(label.encode()).hexdigest()
            destination.mkdir(parents=True,exist_ok=False)
            for name,value in current.items():(destination/name).write_text(value,encoding='utf-8')
            workspace=destination
        elif edits:
            raise CodexIntegrationError('harness2_codex_nonedit_stage_returned_files')
        self.replies[label]=reply
        # 上游数值计量接口要求浮点数，此处仅提供占位值；
        # CLI 或订阅账单仍明确保留未知。
        return Reply(label=label,text=reply,ok=True,cost_usd=0.0,attempts=1,
            workspace=workspace,channel='operator-codex-cli')
