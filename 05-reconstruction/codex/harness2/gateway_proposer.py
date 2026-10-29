"""Bounded model IO for the unmodified Google recursion/selection/library code.

The model returns guidance bytes, not executable shell operations. It gets only
the approved synthetic evidence tree. Every request uses the same Unix broker
as native solver hosts, including selection and experience reflection.
"""
import hashlib
import http.client
import json
import shutil
import socket
from pathlib import Path
from harness2.core.proposer import Reply, ProposerError
from finance_adapter import FILES, validate, read_surface


class UnixHTTP(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__('localhost', timeout=120)
        self.path = str(path)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


class GatewayProposer:
    def __init__(self, *, experiment: Path, gateway_socket: Path,
                 max_output_tokens: int, input_usd_per_million: float,
                 output_usd_per_million: float, max_context_bytes: int = 65536):
        self.experiment=experiment.resolve()
        self.gateway_socket=gateway_socket
        self.max_output_tokens=max_output_tokens
        self.input_rate=input_usd_per_million
        self.output_rate=output_usd_per_million
        self.max_context_bytes=max_context_bytes

    def call(self, mission, context_dir, label, *, harvest=None, max_attempts=1):
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
                evidence[str(path.relative_to(root))]=path.read_text(encoding='utf-8')
        text=json.dumps({'mission':mission,'syntheticFiles':evidence},ensure_ascii=False)
        if len(text.encode())>self.max_context_bytes:
            raise ProposerError('harness2_context_budget_exceeded')
        contract=('Return a JSON object with reply:string containing the requested notes, '
            'choice or experience blocks. For a guidance edit also return files:object '
            'mapping only SKILL.md, tools.md or recovery.md to complete replacement text. '
            'Never return code, scripts, hooks, credentials or accounting approval. '
            'Files are approved synthetic evidence; do not infer hidden answers.')
        body={'model':'deepseek-flash','messages':[{'role':'system','content':contract},
            {'role':'user','content':text}],'max_tokens':self.max_output_tokens,
            'stream':False,'response_format':{'type':'json_object'}}
        conn=UnixHTTP(self.gateway_socket)
        try:
            conn.request('POST','/v1/chat/completions',json.dumps(body).encode(),{'content-type':'application/json'})
            response=conn.getresponse()
            raw=response.read(8*1024*1024+1)
            if response.status!=200 or len(raw)>8*1024*1024:
                raise ProposerError('harness2_budget_or_upstream_stopped',attempts=1)
            result=json.loads(raw)
            usage=result.get('usage',{})
            if not all(isinstance(usage.get(k),int) and usage[k]>=0 for k in ('prompt_tokens','completion_tokens')):
                raise ProposerError('harness2_usage_unknown_stop',attempts=1)
            answer=json.loads(result['choices'][0]['message']['content'])
            reply=answer.get('reply')
            if not isinstance(reply,str) or not reply.strip():
                raise ProposerError('harness2_proposer_reply_invalid',attempts=1)
            workspace=None
            if harvest:
                current=read_surface(root/'harness')
                edits=answer.get('files',{})
                if not isinstance(edits,dict) or set(edits)-FILES or not all(isinstance(v,str) for v in edits.values()):
                    raise ProposerError('harness2_proposer_surface_forbidden',attempts=1)
                current.update(edits);validate(current)
                destination=self.experiment/'broker-guidance'/hashlib.sha256(label.encode()).hexdigest()
                destination.mkdir(parents=True,exist_ok=True)
                for path in destination.iterdir():
                    if not path.is_file() or path.is_symlink():
                        raise ProposerError('harness2_proposer_output_changed')
                    path.unlink()
                for name,value in current.items():
                    (destination/name).write_text(value,encoding='utf-8')
                workspace=destination
            cost=(usage['prompt_tokens']*self.input_rate+usage['completion_tokens']*self.output_rate)/1e6
            return Reply(label=label,text=reply,ok=True,cost_usd=cost,attempts=1,workspace=workspace,channel='fixed-deepseek-budget-gateway')
        except (OSError,ValueError,KeyError,TypeError) as exc:
            raise ProposerError('harness2_proposer_protocol_failed',attempts=1) from None
        finally:
            conn.close()
