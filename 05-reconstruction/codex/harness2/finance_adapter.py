"""Google Harness² BenchmarkAdapter/Substrate seam, not an optimizer reimplementation.

Import only after bootstrap.verify_upstream(). No provider credentials are read.
The native method remains harness2.core.recursion/selection/library. Model execution
fails closed until an OS-isolated, metered runner is installed and verified.
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from harness2.core.spec import BenchPrompts, BenchSpec, ChannelSpec
from harness2.core.tree import SurfaceSpec
from harness2.substrate.base import Install
from harness2.core import prompts as upstream_prompts

FILES = frozenset({"SKILL.md", "tools.md", "recovery.md"})
HOSTS = ("pi", "claude-code", "zcode", "dsh")


def windows_path(path: Path) -> str:
    """Explicit WSL /mnt/<drive> mapping; no loopback or cwd assumptions."""
    value = str(path.absolute())
    match = re.fullmatch(r"/mnt/([a-z])/(.+)", value)
    if match:
        return match[1].upper() + ":/" + match[2]
    if re.match(r"^[A-Za-z]:[/\\]", value):
        return value
    raise ValueError("harness2_explicit_wsl_drive_path_required")


def validate(tree: dict[str, str]) -> None:
    if "SKILL.md" not in tree or set(tree) - FILES:
        raise ValueError("Only SKILL.md, tools.md and recovery.md guidance may change")
    if not tree["SKILL.md"].strip() or sum(len(v.encode()) for v in tree.values()) > 65536:
        raise ValueError("Guidance must be nonempty and at most 65536 UTF-8 bytes")
    if any("\x00" in v for v in tree.values()):
        raise ValueError("Guidance must be UTF-8 text without NUL")


def read_surface(root: Path) -> dict[str, str]:
    if root.is_symlink() or not root.is_dir():
        raise ValueError("harness2_surface_invalid")
    tree = {}
    for path in root.iterdir():
        if path.is_symlink() or not path.is_file() or path.stat().st_nlink != 1:
            raise ValueError("harness2_surface_link_or_directory_forbidden")
        tree[path.name] = path.read_text(encoding="utf-8")
    validate(tree)
    return tree


class FinanceSubstrate:
    def __init__(self, adapter: "FinanceAdapter"):
        self.adapter = adapter
        self.name = "finance-" + adapter.host
        # 固定版本公开 SurfaceSpec，但提示词片段注册仍为私有；
        # 为新接口登记 DATA，绝不替换其方法。
        guidance = ("# Editable finance guidance surface\n"
            "Edit only context/harness/SKILL.md, tools.md or recovery.md. "
            "These UTF-8 files provide instructions only. Do not add code, hooks, "
            "subagents, credentials, accounting approval, permissions or business rules. "
            "Keep uncertainty, native query recovery and human review explicit. "
            "Reply with one <notes> block explaining your guidance edit.")
        upstream_prompts._SURFACE_TEXTS[self.name] = upstream_prompts._SurfaceText(
            surface_md=guidance, tts_surface=guidance,
            inv="Improve general tool and recovery guidance for {deliverable}. {levers}",
            dom="Improve {domain} guidance for {deliverable} within existing authority. {levers}")

    def surface(self) -> SurfaceSpec:
        return SurfaceSpec(
            name=self.name, always_on=("SKILL.md", "tools.md", "recovery.md"),
            always_on_max=65536, always_on_cap_reason="Guidance only; no executable files",
            skill_dir="skills", skill_name_rule="named", trigger_hint="explicit instructions",
            autotrigger_file="SKILL.md", trigger_line="Read {path}",
            subagent_requires_mode=True, plugin_dir=None, hooks_file=None,
            reject_empty_always_on=True,
        )

    def materialise(self, tree_dir: Path, spec, ctx) -> Install:
        if ctx:
            raise ValueError("harness2_extra_integration_files_forbidden")
        tree = read_surface(tree_dir)
        fingerprint = hashlib.sha256(json.dumps(tree, sort_keys=True).encode()).hexdigest()
        stage = Path(tempfile.mkdtemp(prefix="candidate-", dir=self.adapter.root))
        for name, text in tree.items():
            (stage / name).write_text(text, encoding="utf-8")
        return Install(stage, fingerprint, {"host": self.adapter.host})

    def execute(self, task_ref: str, install: Install, run_ids: list[str], timeout: int) -> list[Path]:
        return [self.adapter.execute(task_ref, install.staging_dir, rid, timeout=timeout)
                for rid in run_ids]

    def read_trajectory(self, stream_path: Path, *, obs_trunc: int,
                        max_chars: int, args_trunc: int = 400) -> str:
        # 只有受控回执能进入优化器上下文；宿主原始 stderr 和任意
        # 自由文本错误均留本机，合成探针也不例外。
        value = json.loads(stream_path.read_text(encoding="utf-8"))
        safe = {k: value.get(k) for k in ("status", "host", "operationState",
                "resultCurrent", "confirmationCurrent", "reason", "modelInvoked", "nativeStatus", "innerErrorCount")}
        return ("[ACTION] native_host\n[OBSERVATION] " + json.dumps(safe))[:max_chars]

    def preflight(self) -> None:
        result = self.adapter.bridge("probe", "preflight-" + self.adapter.host)
        if result.get("status") != "probe_passed":
            raise RuntimeError("harness2_native_probe_failed; inspect local native.stderr")


class FinanceAdapter:
    """One explicitly synthetic experiment; expected answers are never task files."""
    def __init__(self, *, root: Path, repo: Path, node: Path, host: str,
                 package_root: str | None = None, cli_path: str | None = None,
                 channels: dict[str, ChannelSpec] | None = None,
                 execution_mode: str = 'model', execution_timeout_ms: int | None = None):
        if host not in HOSTS:
            raise ValueError("harness2_host_invalid")
        self.root, self.repo, self.node = root.resolve(), repo.resolve(), node
        self.host, self.package_root, self.cli_path = host, package_root, cli_path
        if execution_mode not in ('model', 'synthetic-native'):
            raise ValueError('harness2_execution_mode_invalid')
        self.execution_mode = execution_mode
        if execution_timeout_ms is not None and (type(execution_timeout_ms) is not int or execution_timeout_ms < 1):
            raise ValueError('harness2_host_timeout_invalid')
        self.execution_timeout_ms = execution_timeout_ms
        self.windows_bridge = str(node).lower().endswith('.exe')
        self.substrate = FinanceSubstrate(self)
        # 这些是上游改进器通道，与求解器宿主相互独立；
        # 空模型 ID 不能运行，预检不会启动模型。
        self.spec = BenchSpec(name="synthetic-finance-" + host, runs_root=self.root / "runs",
            install_mode="workspace_agents_md", allow_subagents=False,
            prompts=BenchPrompts(work="Inspect a synthetic local finance task and preserve native receipts",
                inv_levers="Clarify tool discovery and recovery instructions",
                dom_levers="Keep enterprise, period and review boundaries explicit"),
            channels=channels or {r: ChannelSpec("opencode", "") for r in ("proposer", "selector")},
            leak_globs=("*expected*", "*heldout*", "*golden*"))

    def tasks(self, split: str = "all") -> list[str]:
        if split not in ("all", "train", "heldout"):
            raise ValueError("harness2_split_invalid")
        return [] if split == "heldout" else ["synthetic-a-2026-01"]

    def domain_of(self, task_id: str) -> str:
        self.task_prompt(task_id)
        return "synthetic-a-2026-01"

    def task_prompt(self, task_id: str) -> str:
        if task_id != "synthetic-a-2026-01":
            raise ValueError("harness2_task_invalid")
        return "Discover the explicit synthetic target. Inspect native Harness status. Preserve unknown and all three state axes. Do not approve accounting results."

    def task_files(self, task_id: str) -> Path | None:
        self.task_prompt(task_id)
        return None

    def bridge(self, action: str, run_id: str, harness_dir: Path | None = None,
               timeout: int | None = None) -> dict:
        if not re.fullmatch(r"[-a-zA-Z0-9_]{1,80}", run_id):
            raise ValueError("harness2_run_id_invalid")
        convert = windows_path if self.windows_bridge else lambda path: str(path.absolute())
        timeout = timeout if timeout is not None else (None if action == 'execute' and self.execution_mode == 'model' else 30)
        request = {"version": "finance-harness2-request/1", "action": action,
            "root": convert(self.root), "host": self.host, "runId": run_id,
            "executionMode": self.execution_mode}
        if timeout is not None:
            request['timeoutMs'] = int(timeout * 1000)
        if self.package_root:
            request["packageRoot"] = self.package_root
        if self.cli_path:
            request["cliPath"] = self.cli_path
        if harness_dir:
            read_surface(harness_dir)
            request["candidateDir"] = convert(harness_dir)
        path = self.root / ("request-" + run_id + ".json")
        # 这只是输入信封，不是回执；绝不保存凭据。
        path.write_text(json.dumps(request), encoding="utf-8")
        proc = subprocess.run([str(self.node), convert(self.repo / "06-workbench/scripts/harness2-bridge.mjs"),
            convert(path)], capture_output=True, text=True, encoding="utf-8", timeout=None if timeout is None else timeout + 20,
            env={"SystemRoot": "C:\\Windows", "PATH": "/usr/bin:/bin"})
        try:
            result = json.loads(proc.stdout.strip())
        except ValueError:
            raise RuntimeError("harness2_bridge_protocol_invalid") from None
        if proc.returncode:
            raise RuntimeError(result.get("code", "harness2_bridge_failed"))
        return result

    def execute(self, task_id: str, harness_dir: Path | None, run_id: str,
                *, timeout: int | None = None) -> Path:
        self.task_prompt(task_id)
        if timeout is None and self.execution_mode == 'model' and self.execution_timeout_ms is not None:
            timeout = self.execution_timeout_ms / 1000
        self.bridge("execute", run_id, harness_dir, timeout=timeout)
        return self.root / "runs" / run_id

    def delivered(self, run_dir: Path) -> bool:
        # 探针完成不能作为业务交付成果。
        path = run_dir / "receipt.json"
        return path.is_file() and json.loads(path.read_text()).get("status") == "native_task_executed"

    def trajectory(self, run_dir: Path, *, obs_trunc: int) -> str:
        return self.substrate.read_trajectory(run_dir / "receipt.json", obs_trunc=obs_trunc, max_chars=50000)

    def deliverable_files(self, run_dir: Path) -> dict[str, str]:
        text = self.deliverable_text(run_dir)
        return {"native-status.json": text} if text else {}

    def deliverable_text(self, run_dir: Path) -> str:
        path = run_dir / 'receipt.json'
        if not path.is_file():
            return ''
        value = json.loads(path.read_text())
        return json.dumps({key: value.get(key) for key in ('status', 'operationState',
            'resultCurrent', 'confirmationCurrent', 'reviewState', 'businessComplete', 'nativeStatus','innerErrorCount')})

    def base_harness(self) -> Path:
        return self.root / "baseline"

    def validate_tree(self, tree: dict[str, str]) -> None:
        validate(tree)

    def score(self, run_dir: Path, task_id: str) -> dict | None:
        self.task_prompt(task_id)
        if self.execution_mode not in ('synthetic-native','model'):
            return None
        result = self.bridge('assess', run_dir.name, run_dir / 'candidate')
        # 此窄范围、独立的原生期间检查，不能证明留出业务语料效果，
        # 也不能据此声称模型质量提升。
        return None if result.get('pass') is None else result
