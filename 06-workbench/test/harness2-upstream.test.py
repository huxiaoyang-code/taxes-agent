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
    def __init__(self):
        self.labels = []

    def call(self, mission, context_dir, label, **kwargs):
        self.labels.append(label)
        if label.startswith("select."):
            text = "```choice\nA\n```\n<why>Retains explicit unknown status.</why>"
            workspace = None
        elif label.startswith("experience."):
            text = "<experience>\ncue: uncertain native receipt\nlesson: query original intent\nevidence: synthetic fixture preserved unknown\nconfidence: synthetic only\n</experience>"
            workspace = None
        else:
            workspace = Path(context_dir) / "harness"
            path = workspace / "SKILL.md"
            path.write_text(path.read_text() + "\nPreserve pending human review.\n")
            text = "<notes>Clarified review boundary.</notes>"
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
        library = Library(root / "library" / mode, adapter.domain_of(adapter.tasks()[0]), adapter.substrate.surface())
        assert library.add(adapter.tasks()[0], result.trees[sel.chosen_label], experience=experience)
        assert library.context_dir() and library.entries() == [adapter.tasks()[0]]
        assert any(label.startswith("experience.") for label in prop.labels)
        assert adapter.score(rd, adapter.tasks()[0]) is None

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
