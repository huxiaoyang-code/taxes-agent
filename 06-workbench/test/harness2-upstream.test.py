"""Real pinned Google core with deterministic synthetic IO; zero model calls.

This tests scheduler/selection/experience contracts, not business model quality.
The native host bridge is checked separately with --native-probe.
"""
import argparse
import json
import sys
import tempfile
import shutil
import importlib.util
import marshal
import struct
import io
from unittest.mock import patch
from pathlib import Path

HERE = Path(__file__).resolve()
REPO = HERE.parents[2]
sys.path.insert(0, str(REPO / "05-reconstruction/codex/harness2"))
from bootstrap import verify_upstream

parser = argparse.ArgumentParser()
parser.add_argument("--upstream", type=Path, required=True)
parser.add_argument("--native-probe", type=Path)
parser.add_argument("--pi-root")
parser.add_argument("--native-cycle", action="store_true")
args = parser.parse_args()
verified = verify_upstream(args.upstream)
with tempfile.TemporaryDirectory(prefix='harness2-pyc-attack-') as directory:
    copied=Path(directory)/'source';shutil.copytree(args.upstream,copied)
    source=copied/'harness2/__init__.py'
    cache=Path(importlib.util.cache_from_source(str(source)));cache.parent.mkdir(exist_ok=True)
    fake=compile("raise RuntimeError('UNVERIFIED-CACHED-CODE-EXECUTED')",str(source),'exec')
    cache.write_bytes(importlib.util.MAGIC_NUMBER+struct.pack('<III',0,int(source.stat().st_mtime),source.stat().st_size)+marshal.dumps(fake))
    try:
        verify_upstream(copied)
        raise AssertionError('matching mtime/size forged pyc accepted')
    except RuntimeError as error:
        assert str(error)=='harness2_unverified_compiled_source',error
from finance_adapter import FinanceAdapter, read_surface
from harness2.core.spec import BenchmarkAdapter, RunView
from harness2.substrate.base import Substrate
from harness2.core.proposer import Reply
from harness2.core.recursion import run_parallel, run_sequential
from harness2.core.selection import run_selection, reflect_adoption, selection_pool
from harness2.core.library import Library
from harness2.core.tree import write_tree
from codex_proposer import CodexProposer, CodexIntegrationError, classify_reflection
from harness2.core.proposer import ProposerError


class SyntheticAdapter(FinanceAdapter):
    """Synthetic IO fixture: never claimed as a finance host execution."""
    def execute(self, task_id, harness_dir, run_id, *, timeout=None):
        path = self.root / "runs" / run_id
        path.mkdir(parents=True, exist_ok=True)
        (path / "answer.txt").write_text("Synthetic native status remains unknown; human review pending.")
        return path

    def delivered(self, run_dir):
        return (run_dir / "answer.txt").is_file()

    def trajectory(self, run_dir, *, obs_trunc):
        return "[ACTION] synthetic_fixture\n[OBSERVATION] unknown; pending human review"

    def deliverable_files(self, run_dir):
        return {"answer.txt": self.deliverable_text(run_dir)}

    def deliverable_text(self, run_dir):
        return (run_dir / "answer.txt").read_text()

    def score(self,run_dir,task_id):
        return None


class DeterministicProposer:
    """Only the model IO seam is synthetic. Google method code is unmodified."""
    def __init__(self,reflection_reply=None):
        self.labels = []
        self.replies = {}
        self.reflection_reply=reflection_reply

    def call(self, mission, context_dir, label, **kwargs):
        self.labels.append(label)
        if label.startswith("select."):
            text = "```choice\nA\n```\n<why>Retains explicit unknown status.</why>"
            workspace = None
        elif label.startswith("experience."):
            text = self.reflection_reply or "<experience>\ncue: uncertain native receipt\nlesson: query original intent\nevidence: synthetic fixture preserved unknown\nconfidence: synthetic only\n</experience>"
            workspace = None
        else:
            workspace = Path(context_dir) / "harness"
            path = workspace / "SKILL.md"
            path.write_text(path.read_text() + "\nPreserve pending human review.\n")
            text = "<notes>Clarified review boundary.</notes>"
        self.replies[label]=text
        return Reply(label=label, text=text, ok=True, workspace=workspace, attempts=1)


with tempfile.TemporaryDirectory(prefix="harness2-core-") as directory:
    root = Path(directory)
    adapter = SyntheticAdapter(root=root, repo=REPO, node=Path("/mnt/d/node.exe"), host="pi")
    assert isinstance(adapter, BenchmarkAdapter)
    assert isinstance(adapter.substrate, Substrate)
    assert adapter.tasks("heldout") == []
    base_tree = {"SKILL.md": "# Synthetic\nPreserve unknown.\n", "tools.md": "", "recovery.md": ""}
    write_tree(adapter.substrate.surface(), base_tree, adapter.base_harness())
    adapter.validate_tree(base_tree)
    for bad in ({**base_tree, "scripts/evil.py": "pass"}, {"SKILL.md": ""}):
        try:
            adapter.validate_tree(bad)
            raise AssertionError("forbidden candidate accepted")
        except ValueError:
            pass
    staged = adapter.substrate.materialise(adapter.base_harness(), adapter.spec, {})
    assert read_surface(staged.staging_dir) == base_tree
    for mode, native_method in (("agg", run_parallel), ("seq", run_sequential)):
        work = root / mode
        prop = DeterministicProposer()
        rd = adapter.execute(adapter.tasks()[0], None, mode + "-base")
        base = [RunView("base1", mode + "-base", rd, True, True)]
        result = native_method(adapter.tasks()[0], 1, base, adapter=adapter, prop=prop,
            work_dir=work, run_id_of=lambda label: mode + "-" + label,
            base_tree=base_tree, propose_workers=1, rollout_workers=1)
        assert result.ok, result.to_dict()
        assert len(result.stages) == 3, result.to_dict()
        pool = selection_pool(mode, 1, result.rollouts, base)
        sel = run_selection(adapter.tasks()[0], 1, mode, pool, adapter=adapter,
                            prop=prop, work_dir=work, pool_kind="finals")
        assert sel.ok and not sel.chosen_is_base
        experience = reflect_adoption(adapter.tasks()[0], sel, pool, adapter=adapter,
                                      prop=prop, work_dir=work)
        assert classify_reflection(prop.replies['experience.'+mode+'1'],experience)=='recorded'
        library = Library(root / "library" / mode, adapter.domain_of(adapter.tasks()[0]), adapter.substrate.surface())
        assert library.add(adapter.tasks()[0], result.trees[sel.chosen_label], experience=experience)
        assert library.context_dir() and library.entries() == [adapter.tasks()[0]]
        assert any(label.startswith("experience.") for label in prop.labels)
        assert adapter.score(rd, adapter.tasks()[0]) is None

        # NO_ENTRY 是原提示词明确决定不保存经验的结果。
        # 在独立目录树中完整保留上方记录的用例及其库。
        no_entry_work=root/(mode+'-no-entry');shutil.copytree(work,no_entry_work)
        no_entry_reply='<edits>\nNo reusable execution contrast is evidenced.\n</edits>\n\nNO_ENTRY'
        no_entry_prop=DeterministicProposer(reflection_reply=no_entry_reply)
        no_entry=reflect_adoption(adapter.tasks()[0],sel,pool,adapter=adapter,prop=no_entry_prop,work_dir=no_entry_work)
        assert no_entry=={}
        assert classify_reflection(no_entry_prop.replies['experience.'+mode+'1'],no_entry)=='no_entry'
        no_entry_library=Library(root/'no-entry-library'/mode,adapter.domain_of(adapter.tasks()[0]),adapter.substrate.surface())
        assert no_entry_library.add(adapter.tasks()[0],result.trees[sel.chosen_label],experience=no_entry) is None
        assert no_entry_library.entries()==[] and no_entry_library.context_dir() is None
        assert not list(no_entry_library.root.rglob('EXPERIENCE.md'))

    assert classify_reflection('NO_ENTRY',{})=='no_entry'
    for malformed in (None,'','<edits>Missing reflection decision</edits>','<edits>NO_ENTRY appears only in a quotation</edits>','NO_ENTRY plus unexplained text','<experience>invalid</experience>\nNO_ENTRY','<edits></edits>\nNO_ENTRY','<edits>extra</edits>closing</edits>\nNO_ENTRY'):
        try:classify_reflection(malformed,{})
        except CodexIntegrationError:pass
        else:raise AssertionError('malformed or absent reflection was accepted as NO_ENTRY')

    # 覆盖真实 Google 捕获边界：优化器集成失败
    # 必须向外抛出，不能变成以基线兜底的候选执行。
    assert not issubclass(CodexIntegrationError,ProposerError)
    class FailedWorker:
        def __init__(self, protocol=False):
            self.stdin=io.BytesIO()
            self.returncode=0 if protocol else 23
            self.protocol=protocol
        def communicate(self, **kwargs):
            response={'ok':False,'code':'codex_process_failed','metadata':{'status':'process_failed','exitCode':23}}
            return (b'not-json' if self.protocol else json.dumps(response).encode(),b'synthetic worker failure')
    for mode,native_method in (('agg',run_parallel),('seq',run_sequential)):
        for failure in ('process','protocol','transport'):
            prop=CodexProposer(experiment=root,codex_cli='synthetic-codex',node='synthetic-node',work_root=str(root/'unused-context'))
            work=root/('fatal-'+mode+'-'+failure)
            popen_options={'side_effect':OSError('synthetic transport failure')} if failure=='transport' else {'return_value':FailedWorker(failure=='protocol')}
            with patch('codex_proposer.subprocess.Popen',**popen_options) as popen,patch.object(adapter,'execute',wraps=adapter.execute) as execute:
                try:
                    native_method(adapter.tasks()[0],1,base,adapter=adapter,prop=prop,
                        work_dir=work,run_id_of=lambda label:'forbidden-'+label,
                        base_tree=base_tree,propose_workers=1,rollout_workers=1)
                    raise AssertionError('fatal optimizer failure became a fallback rollout')
                except CodexIntegrationError as error:
                    assert str(error)=='harness2_codex_'+('process_failed' if failure=='process' else 'worker_'+failure+'_failed'),error
                assert execute.call_count==0,'optimizer failure must not execute fallback candidates'
                assert popen.call_count==1,'queued proposer jobs must reuse the sticky fatal failure'
                assert len(prop.invocations)==1
                audit=prop.invocations[0]
                assert audit['status']==('process_failed' if failure=='process' else 'worker_'+failure+'_failed'),audit
                assert list((root/'codex-invocations').glob('*.json'))
                try:prop.call('synthetic',root,'after-fatal')
                except CodexIntegrationError:pass
                else:raise AssertionError('sticky optimizer failure was cleared')
                assert popen.call_count==1

if args.native_probe:
    adapter = FinanceAdapter(root=args.native_probe, repo=REPO, node=Path("/mnt/d/node.exe"), host="pi", package_root=args.pi_root)
    adapter.substrate.preflight()
    if args.native_cycle:
        adapter = FinanceAdapter(root=args.native_probe, repo=REPO, node=Path('/mnt/d/node.exe'), host='pi', package_root=args.pi_root, execution_mode='synthetic-native')
        task_id = adapter.tasks()[0]
        base_dir = adapter.execute(task_id, None, 'google-native-base', timeout=60)
        assert adapter.delivered(base_dir)
        base = [RunView('base1', 'google-native-base', base_dir, True, True)]
        prop = DeterministicProposer()
        base_tree = read_surface(adapter.base_harness())
        work = adapter.root / 'google-native-agg'
        result = run_parallel(task_id, 1, base, adapter=adapter, prop=prop, work_dir=work,
            run_id_of=lambda label: 'google-native-' + label, base_tree=base_tree,
            propose_workers=1, rollout_workers=1)
        assert result.ok and all(r.delivered for r in result.rollouts.values()), result.to_dict()
        pool = selection_pool('agg', 1, result.rollouts, base)
        sel = run_selection(task_id, 1, 'agg', pool, adapter=adapter, prop=prop, work_dir=work, pool_kind='finals')
        assert sel.ok
        experience = reflect_adoption(task_id, sel, pool, adapter=adapter, prop=prop, work_dir=work)
        library = Library(adapter.root / 'native-library', adapter.domain_of(task_id), adapter.substrate.surface())
        assert library.add(task_id, result.trees[sel.chosen_label], experience=experience)
        assessment = adapter.score(pool[sel.chosen_label].run_dir, task_id)
        assert assessment and assessment['pass'], assessment

print(json.dumps({"status": "passed", **verified,
    "nativeGoogleCore": ["run_parallel", "run_sequential", "run_selection", "reflect_adoption", "Library"],
    "modelIO": "deterministic synthetic fixture", "nativePiBridge": bool(args.native_probe),
    "nativeProductionAdapterCycle": args.native_cycle, "businessModelQualityVerified": False}))
