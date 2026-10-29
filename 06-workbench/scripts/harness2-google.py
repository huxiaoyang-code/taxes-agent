#!/usr/bin/env python3
"""Pinned Google method: operator Codex optimizes, native host model executes.

Codex's saved login/default model remains on its outer host. The solver gateway
only forwards native execution requests; it never generates harness proposals.
"""
import argparse
import json
import sys
import hashlib
from pathlib import Path

REPO=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(REPO/'05-reconstruction/codex/harness2'))
from bootstrap import verify_upstream

p=argparse.ArgumentParser()
for name in ('upstream','repo-stage','host-stage','node','work','canary'):
    p.add_argument('--'+name,type=Path,required=True)
p.add_argument('--host',choices=('pi','claude-code','zcode','dsh'),default='pi')
p.add_argument('--package-root',default='/host/node_modules/@earendil-works/pi-coding-agent')
p.add_argument('--cli-path')
p.add_argument('--gateway-socket',type=Path)
p.add_argument('--budget-config',type=Path)
p.add_argument('--optimizer',choices=('codex','synthetic-fixture'),default='codex')
p.add_argument('--codex-cli')
p.add_argument('--codex-node')
p.add_argument('--codex-work-root')
p.add_argument('--codex-script',help=argparse.SUPPRESS)
p.add_argument('--optimizer-timeout-ms',type=int)
p.add_argument('--executor-timeout-ms',type=int)
p.add_argument('--execution-mode',choices=('model','synthetic-native'),required=True,
    help='Required: model executes the real native model; synthetic-native is an explicit no-model fixture')
p.add_argument('--mode',choices=('agg','seq'),default='agg')
p.add_argument('--experiment',default='experiment')
args=p.parse_args()
for value in (args.optimizer_timeout_ms,args.executor_timeout_ms):
    if value is not None and value<1:p.error('explicit timeout must be a positive number of milliseconds')
verified=verify_upstream(args.upstream)


def file_fingerprint(path):
    path=Path(path)
    if path.is_symlink() or not path.is_file():
        raise RuntimeError('harness2_controller_file_binding_invalid')
    return {'path':str(path.resolve()),'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}


def tree_fingerprint(path):
    path=Path(path)
    if path.is_symlink() or not path.is_dir():
        raise RuntimeError('harness2_controller_tree_binding_invalid')
    files=[]
    for item in sorted(path.rglob('*')):
        if item.is_symlink():raise RuntimeError('harness2_controller_tree_binding_invalid')
        if item.is_file():files.append((str(item.relative_to(path)),hashlib.sha256(item.read_bytes()).hexdigest()))
    return {'path':str(path.resolve()),'sha256':hashlib.sha256(json.dumps(files,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()}

for module in ('bootstrap.py','finance_adapter.py','linux_adapter.py','codex_proposer.py','codex-proposer-worker.mjs','sandbox.py'):
    if (REPO/'05-reconstruction/codex/harness2'/module).read_bytes()!=(args.repo_stage/'05-reconstruction/codex/harness2'/module).read_bytes():
        raise RuntimeError('harness2_controller_stage_source_mismatch:'+module)
from sandbox import LinuxSandbox
from linux_adapter import LinuxFinanceAdapter
from finance_adapter import read_surface
from harness2.core.proposer import Reply
from harness2.core.spec import RunView
from harness2.core.recursion import run_mode
from harness2.core import recursion as native_recursion
from harness2.core.selection import selection_pool,trivial_selection,reflect_adoption
from harness2.core.library import Library
native_recursion.STAGE_ATTEMPTS=1
native_recursion.TRANSPORT_ATTEMPTS=1


class SyntheticEditor:
    def call(self,mission,root,label,**kwargs):
        if label.startswith('select.'):
            return Reply(label,'```choice\nA\n```\n<why>Preserves native uncertainty.</why>',True,attempts=1)
        if label.startswith('experience.'):
            return Reply(label,'<experience>\ncue: pending native review\nlesson: preserve state axes\nevidence: actual synthetic period inspection\n</experience>',True,attempts=1)
        path=Path(root)/'harness'
        skill=path/'SKILL.md';skill.write_text(skill.read_text()+'\nKeep human review pending.\n')
        return Reply(label,'<notes>Clarified existing review boundary.</notes>',True,attempts=1,workspace=path)


if args.optimizer=='codex':
    if not all((args.codex_cli,args.codex_node,args.codex_work_root)):
        p.error('Codex optimizer requires explicit --codex-cli --codex-node --codex-work-root; no DeepSeek optimizer fallback')
    from codex_proposer import CodexProposer,launch_path
    for mounted in (args.work,args.repo_stage,args.host_stage):
        if Path(launch_path(args.codex_work_root)).resolve().is_relative_to(mounted.resolve()):
            p.error('Codex outer-host context must be outside every candidate-visible mount')
elif args.execution_mode=='model':
    p.error('model execution requires the Codex optimizer; synthetic-fixture is for explicit no-model tests')

if args.execution_mode=='model':
    if not args.gateway_socket or not args.budget_config:
        p.error('model requires an already-running shared budget gateway and explicit config')
    budget=json.loads(args.budget_config.read_text())
    if str(args.gateway_socket)!=budget['socketPath']:
        p.error('gateway socket must match the fixed budget config')
    for sensitive in (args.gateway_socket,args.budget_config,Path(budget['ledgerPath'])):
        for mounted in (args.work,args.repo_stage,args.host_stage):
            if sensitive.resolve().is_relative_to(mounted.resolve()):
                p.error('budget socket/config/ledger must be outside every mounted work or source tree')
    if args.gateway_socket.parent.resolve()!=Path(budget['ledgerPath']).parent.resolve() or args.budget_config.parent.resolve()!=args.gateway_socket.parent.resolve():
        p.error('budget config, socket and ledger require one separate private broker directory')
else:
    budget=None

sandbox=LinuxSandbox(work=args.work,repo_stage=args.repo_stage,host_stage=args.host_stage,
    node=args.node,gateway_socket=args.gateway_socket)
execution_options={'execution_timeout_ms':args.executor_timeout_ms} if args.executor_timeout_ms is not None else {}
adapter=LinuxFinanceAdapter(sandbox=sandbox,root=args.work/args.experiment,canary=args.canary,
    host=args.host,package_root=args.package_root,cli_path=args.cli_path,execution_mode=args.execution_mode,
    max_output_tokens=budget.get('maxOutputTokens') if budget else None,**execution_options)
if not adapter.root.exists():
    adapter.prepare()
controller_digest=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
controller_manifest=adapter.root/'controller.json'
optimizer_config={'kind':args.optimizer,'cli':args.codex_cli,'node':args.codex_node,
    'script':args.codex_script,'workRoot':args.codex_work_root,'timeoutMs':args.optimizer_timeout_ms}
binding={'method':args.mode,'host':args.host,'executionMode':args.execution_mode,
    'packageRoot':args.package_root,'nativeCli':args.cli_path,'optimizer':optimizer_config,
    'executorTimeoutMs':args.executor_timeout_ms,
    'executorConfig':hashlib.sha256(json.dumps(budget,sort_keys=True,separators=(',',':')).encode()).hexdigest() if budget else None,
    'executorConfigPath':str(args.budget_config.resolve()) if budget else None,
    'gatewaySocket':str(args.gateway_socket.resolve()) if args.gateway_socket else None,
    'node':file_fingerprint(args.node),'sourceStage':tree_fingerprint(args.repo_stage),
    'hostStage':tree_fingerprint(args.host_stage),'experiment':file_fingerprint(adapter.root/'experiment.json'),
    'snapshot':tree_fingerprint(adapter.root/'snapshot'),'baseline':tree_fingerprint(adapter.base_harness()),
    'assessor':file_fingerprint(REPO/'06-workbench/scripts/harness2-assess.mjs'),
    'canary':file_fingerprint(args.canary)}
if args.optimizer=='codex':
    binding['codexCli']=file_fingerprint(launch_path(args.codex_cli))
    binding['codexNode']=file_fingerprint(launch_path(args.codex_node))
    if args.codex_script:binding['codexScript']=file_fingerprint(launch_path(args.codex_script))
binding_digest=hashlib.sha256(json.dumps(binding,sort_keys=True,separators=(',',':')).encode()).hexdigest()
if controller_manifest.exists():
    saved=json.loads(controller_manifest.read_text())
    if saved.get('sourceDigest')!=controller_digest:
        raise RuntimeError('harness2_controller_source_changed')
    if saved.get('binding')!=binding:
        raise RuntimeError('harness2_controller_binding_changed')
else:
    controller_manifest.write_text(json.dumps({'sourceDigest':controller_digest,'binding':binding}))
completed_cycle=adapter.root/'cycle.json'
if completed_cycle.exists():
    previous=json.loads(completed_cycle.read_text())
    if previous.get('status')!='completed' or previous.get('controllerBindingSha256')!=binding_digest or previous.get('executionMode')!=args.execution_mode or previous.get('method')!=args.mode or previous.get('host')!=args.host or previous.get('optimizer',{}).get('kind')!=args.optimizer:
        raise RuntimeError('harness2_completed_cycle_binding_changed')
    print(json.dumps({**previous,'resumeStatus':'already_completed'}));raise SystemExit(0)
adapter.substrate.preflight()
prop=CodexProposer(experiment=adapter.root,codex_cli=args.codex_cli,node=args.codex_node,
    work_root=args.codex_work_root,timeout_ms=args.optimizer_timeout_ms,
    codex_script=args.codex_script) if args.optimizer=='codex' else SyntheticEditor()
task=adapter.tasks()[0]
base_dir=adapter.execute(task,None,'base1')
if not adapter.delivered(base_dir):
    raise RuntimeError('harness2_baseline_missing_native_deliverable')
base=[RunView('base1','base1',base_dir,True,True)]
work=adapter.root/'google-method'
result=run_mode(args.mode,task,1,base,adapter=adapter,prop=prop,work_dir=work,
    run_id_of=lambda label:'native-'+label,base_tree=read_surface(adapter.base_harness()),
    propose_workers=1,rollout_workers=1)
if not result.ok or result.fell_back or not all(run.delivered for run in result.rollouts.values()):
    raise RuntimeError('harness2_candidate_native_task_incomplete')
pool=selection_pool(args.mode,1,result.rollouts,base)
# k=1 has exactly one final. Use the original upstream single-final path;
# do not spend an optimizer session pretending to compare one candidate.
selection=trivial_selection(task,1,args.mode,pool,adapter=adapter,work_dir=work)
if not selection.ok:
    raise RuntimeError('harness2_selection_incomplete')
experience=reflect_adoption(task,selection,pool,adapter=adapter,prop=prop,work_dir=work)
library=Library(adapter.root/'experience-library',adapter.domain_of(task),adapter.substrate.surface())
if not library.add(task,result.trees[selection.chosen_label],experience=experience):
    raise RuntimeError('harness2_experience_incomplete')
# Only AFTER committed selection; independent local business evidence is never
# sent back to the optimizer. No accountant feedback is synthesized.
assessment=adapter.score(pool[selection.chosen_label].run_dir,task)
if not assessment or not assessment.get('pass'):
    raise RuntimeError('harness2_independent_assessment_incomplete')
ledger=json.loads(Path(budget['ledgerPath']).read_text()) if budget else None
rates=budget and budget.get('inputUsdPerMillion') is not None and budget.get('outputUsdPerMillion') is not None
known_cost=sum((event['usage']['inputTokens']*budget['inputUsdPerMillion']+event['usage']['outputTokens']*budget['outputUsdPerMillion'])/1e6 for event in ledger['events']) if rates and all(event.get('usage') for event in ledger['events']) else None
summary={'version':'finance-harness2-cycle/1','status':'completed','host':args.host,
    'method':args.mode,'executionMode':args.execution_mode,'controllerBindingSha256':binding_digest,
    'upstream':verified,'modelInvoked':bool(budget) or args.optimizer=='codex','assessment':assessment,
    'optimizer':{'kind':args.optimizer,'modelSelection':'inherited' if args.optimizer=='codex' else 'synthetic','actualBilledUsd':None,'invocations':getattr(prop,'invocations',[]),'upstreamNumericCost':'unpriced_placeholder' if args.optimizer=='codex' else 'no_model_calls'},
    'executor':{'host':args.host,'model':budget.get('model','deepseek-flash') if budget else None,'gatewayRole':'native_execution_only' if budget else None,'calls':ledger['calls'] if ledger else 0},
    'methodCostKind':'billing_unknown_separate_roles' if args.optimizer=='codex' else 'no_model_calls',
    'executorConservativeEstimatedUsd':known_cost,'executorReservedUpperBoundUsd':ledger.get('reservedUsd') if ledger else None,
    'actualBilledUsd':None,
    'businessComplete':False,'heldoutVerified':False,'candidatePublished':False}
(adapter.root/'cycle.json').write_text(json.dumps(summary,indent=2))
print(json.dumps(summary))
