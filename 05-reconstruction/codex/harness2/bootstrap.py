"""Verify fixed original Git blobs before loading Google research code."""
import hashlib
import json
import sys
from pathlib import Path
sys.dont_write_bytecode = True

COMMIT = "1cfe254e8d25b15f37048c3730134686abe60335"


def verify_upstream(root: Path) -> dict:
    if sys.platform != "linux" or not ((3, 12) <= sys.version_info[:2] < (3, 14)):
        raise RuntimeError("harness2_linux_python_3_12_or_3_13_required")
    lock = json.loads(Path(__file__).with_name("upstream-lock.json").read_text(encoding="utf-8"))
    if lock["commit"] != COMMIT or lock["repository"] != "google-research/harness2":
        raise RuntimeError("harness2_upstream_lock_invalid")
    if root.is_symlink():
        raise RuntimeError("harness2_upstream_symlink_forbidden")
    forbidden={'.pyc','.pyo','.so','.pyd','.dll','.pyz','.zip'}
    if any(p.is_symlink() for p in root.rglob('*')):
        raise RuntimeError('harness2_upstream_symlink_forbidden')
    if any(p.is_file() and p.suffix.lower() in forbidden for p in root.rglob('*')):
        raise RuntimeError('harness2_unverified_compiled_source')
    for entry in lock["files"]:
        path = root / entry["path"]
        if path.is_symlink() or not path.is_file():
            raise RuntimeError("harness2_pinned_source_missing")
        for parent in path.relative_to(root).parents:
            if (root / parent).is_symlink():
                raise RuntimeError("harness2_upstream_symlink_forbidden")
        data = path.read_bytes()
        actual = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
        if actual != entry["sha"]:
            raise RuntimeError("harness2_upstream_blob_changed:" + entry["path"])
    # 拒绝注入的 Python 模块，不采信可修改的环境准备标记。
    allowed = {e["path"] for e in lock["files"] if e["path"].endswith(".py")}
    if any(str(p.relative_to(root)) not in allowed for p in root.rglob("*.py")):
        raise RuntimeError("harness2_unpinned_python_source")
    sys.path.insert(0, str(root.resolve()))
    return {"commit": COMMIT, "verifiedFiles": len(lock["files"]), "modelInvoked": False}
