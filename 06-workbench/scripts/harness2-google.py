#!/usr/bin/env python3
"""Pinned Google Harness², one bounded synthetic task and isolated native host.

Start the separate budget server first for --execution-mode model. No credential
is accepted on argv or read here. Synthetic-native uses no model or gateway.
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
p.add_argument('--execution-mode',choices=('model','synthetic-native'),default='synthetic-native')
p.add_argument('--mode',choices=('agg','seq'),default='agg')
p.add_argument('--experiment',default='experiment')
args=p.parse_args()
verified=verify_upstream(args.upstream)
for module in ('bootstrap.py','finance_adapter.py','linux_adapter.py','gateway_proposer.py','sandbox.py'):
    if (REPO/'05-reconstruction/codex/harness2'/module).read_bytes()!=(args.repo_stage/'05-reconstruction/codex/harness2'/module).read_bytes():
        raise RuntimeError('harness2_controller_stage_source_mismatch:'+module)
from sandbox import LinuxSandbox
from linux_adapter import LinuxFinanceAdapter
from finance_adapter import read_surface
from harness2.core.proposer import Reply
from harness2.core.spec import RunView
from harness2.core.recursion import run_mode
from harness2.core import recursion as native_recursion
from harness2.core.selection import selection_pool,run_selection,reflect_adoption
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


if args.execution_mode=='model':
    if not args.gateway_socket or not args.budget_config:
        p.error('model requires an already-running shared budget gateway and explicit config')
    from gateway_proposer import GatewayProposer
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
adapter=LinuxFinanceAdapter(sandbox=sandbox,root=args.work/args.experiment,canary=args.canary,
    host=args.host,package_root=args.package_root,cli_path=args.cli_path,execution_mode=args.execution_mode)
if not adapter.root.exists():
    adapter.prepare()
controller_digest=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
controller_manifest=adapter.root/'controller.json'
if controller_manifest.exists():
    if json.loads(controller_manifest.read_text())['sourceDigest']!=controller_digest:
        raise RuntimeError('harness2_controller_source_changed')
else:
    controller_manifest.write_text(json.dumps({'sourceDigest':controller_digest}))
adapter.substrate.preflight()
prop=GatewayProposer(experiment=adapter.root,gateway_socket=args.gateway_socket,
    max_output_tokens=budget['maxOutputTokens'],input_usd_per_million=budget['inputUsdPerMillion'],
    output_usd_per_million=budget['outputUsdPerMillion'],max_context_bytes=58000) if budget else SyntheticEditor()
task=adapter.tasks()[0]
base_dir=adapter.execute(task,None,'base1',timeout=120)
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
selection=run_selection(task,1,args.mode,pool,adapter=adapter,prop=prop,work_dir=work,pool_kind='finals')
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
known_cost=None if ledger and any(event.get('usage') is None for event in ledger['events']) else sum((event['usage']['inputTokens']*budget['inputUsdPerMillion']+event['usage']['outputTokens']*budget['outputUsdPerMillion'])/1e6 for event in ledger['events']) if ledger else 0
summary={'version':'finance-harness2-cycle/1','status':'completed','host':args.host,
    'method':args.mode,'upstream':verified,'modelInvoked':bool(budget),'assessment':assessment,
    'methodCostKind':'conservative_estimate' if budget else 'no_model_calls',
    'conservativeEstimatedUsd':known_cost,'reservedUpperBoundUsd':ledger['reservedUsd'] if ledger else 0,
    'actualBilledUsd':None,
    'businessComplete':False,'heldoutVerified':False,'candidatePublished':False}
(adapter.root/'cycle.json').write_text(json.dumps(summary,indent=2))
print(json.dumps(summary))
