"""FreeCAD headless engine runner for RESEARCH-CAD-005.

Process-isolated execution of engine workloads inside FreeCADCmd (the
proven cad-001/cad-002 runner conventions), extended for the
operational-robustness scope of this work item:

- every invocation is a FRESH PROCESS (no uncontrolled process-global
  state across engine calls — the isolation model the adapter boundary
  requires);
- the parent measures process lifecycle wall time; the script measures
  engine-operation wall time inside the engine process, so process
  startup (application start/load) is cleanly separated from engine
  operation time;
- child peak RSS is observed by polling /proc (``ChildProcessWatcher``);
- timeouts kill the process group and raise a typed ``EngineTimeout``;
- cancellation is exposed as ``spawn()`` + ``cancel()`` so the
  benchmark can interrupt a long-running engine call.

Engine workloads (fixture build, open/recompute/save/reopen, selection)
are generated as self-contained scripts; results and measurements come
back as one JSON blob on a ``@@RESULTS@@`` marker line.
"""
from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any, Optional

from .resources import ChildProcessWatcher

REPO_ROOT = Path(__file__).resolve().parents[1]  # research/cad-005
CAD001_ROOT = REPO_ROOT.parent / "cad-001"

SCRIPT_PRELUDE = """
import json, sys, time, traceback

CHECKS = []
MEASUREMENTS = {}

def record(cid, description, ok, epistemic="NATIVE", details=None):
    CHECKS.append({
        "id": cid,
        "description": description,
        "status": "pass" if ok else "fail",
        "epistemic": epistemic,
        "details": details or {},
    })

def measure(key, value):
    MEASUREMENTS[key] = value

def timed(key):
    class _Ctx:
        def __enter__(self):
            self.t0 = time.perf_counter()
            return self
        def __exit__(self, *exc):
            MEASUREMENTS[key] = round((time.perf_counter() - self.t0) * 1000.0, 3)
    return _Ctx()
"""

SCRIPT_EPILOGUE = """
import os
_payload = json.dumps({"checks": CHECKS, "measurements": MEASUREMENTS})
_result_path = os.environ.get("OFFISOS_RESULT_FILE")
if _result_path:
    # Atomic file-based result transfer: FreeCAD's console progress bar
    # writes partial lines without trailing newlines to stdout, which
    # corrupts any marker line printed to stdout (observed: '(NN %)\t\t'
    # prefixes interleaving with the JSON). A separate result file cannot
    # be corrupted by console chatter; the write is temp+rename atomic.
    with open(_result_path + ".tmp", "w") as _fh:
        _fh.write(_payload)
    os.replace(_result_path + ".tmp", _result_path)
print("@@RESULTFILE@@" + (_result_path or ""))
"""


class EngineTimeout(Exception):
    """Typed timeout: the engine subprocess exceeded its time budget."""

    def __init__(self, timeout_s: float, script_hint: str):
        super().__init__(
            f"FreeCAD engine subprocess exceeded timeout {timeout_s}s ({script_hint})"
        )
        self.timeout_s = timeout_s
        self.script_hint = script_hint


class EngineScriptError(Exception):
    """The engine script itself failed (unhandled exception inside FreeCAD)."""

    def __init__(self, traceback_text: str, returncode: int):
        super().__init__(f"engine script failed (rc={returncode}): {traceback_text[-800:]}")
        self.traceback_text = traceback_text
        self.returncode = returncode


def find_freecadcmd() -> Optional[str]:
    env = os.environ.get("FREECADCMD")
    if env and Path(env).exists():
        return env
    for root in (REPO_ROOT, CAD001_ROOT):
        for name in ("FreeCADCmd", "freecadcmd"):
            local = root / ".freecad" / "squashfs-root" / "usr" / "bin" / name
            if local.exists():
                return str(local)
    for name in ("FreeCADCmd", "freecadcmd"):
        found = shutil.which(name)
        if found:
            return found
    return None


def freecad_available() -> bool:
    return find_freecadcmd() is not None


def run_script(
    script_body: str,
    freecadcmd: str,
    timeout: float = 600.0,
    script_hint: str = "unnamed",
) -> dict[str, Any]:
    """Run a script inside FreeCADCmd; return its JSON result.

    Parent-side wall time (process lifecycle incl. startup) is added
    under ``process_wall_ms``; the child's peak RSS observation under
    ``child_resources``. Results travel through a file (see
    SCRIPT_EPILOGUE) so console progress chatter cannot corrupt them.
    """
    t0 = time.perf_counter()
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".py", delete=False
    ) as script_file:
        script_file.write(SCRIPT_PRELUDE + script_body + SCRIPT_EPILOGUE)
        script_path = script_file.name
    result_fd, result_path = tempfile.mkstemp(suffix=".json")
    os.close(result_fd)
    os.unlink(result_path)  # child creates it atomically
    env = dict(os.environ, OFFISOS_RESULT_FILE=result_path)
    try:
        proc = subprocess.Popen(
            [freecadcmd, script_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
            start_new_session=True,  # own process group for clean kill
        )
        watcher = ChildProcessWatcher(proc.pid)
        watcher.start()
        try:
            stdout, stderr = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            _kill_group(proc)
            proc.communicate()
            raise EngineTimeout(timeout, script_hint)
        usage = watcher.finish()
        wall_ms = (time.perf_counter() - t0) * 1000.0
        result = _parse_results(result_path, stdout, proc.returncode, stderr)
        result["process_wall_ms"] = round(wall_ms, 3)
        result["returncode"] = proc.returncode
        result["child_resources"] = usage.to_dict()
        result["script_hint"] = script_hint
        return result
    finally:
        os.unlink(script_path)
        if os.path.exists(result_path):
            os.unlink(result_path)


def spawn_script(script_body: str, freecadcmd: str, script_hint: str = "unnamed"):
    """Spawn a FreeCADCmd script WITHOUT waiting (for cancellation tests).

    Returns (proc, script_path, watcher, result_path) — the caller
    cancels via ``cancel_script`` or reaps via ``finish_script``.
    """
    script_file = tempfile.NamedTemporaryFile(
        mode="w", suffix=".py", delete=False
    )
    script_file.write(SCRIPT_PRELUDE + script_body + SCRIPT_EPILOGUE)
    script_file.close()
    result_fd, result_path = tempfile.mkstemp(suffix=".json")
    os.close(result_fd)
    os.unlink(result_path)
    env = dict(os.environ, OFFISOS_RESULT_FILE=result_path)
    proc = subprocess.Popen(
        [freecadcmd, script_file.name],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
        start_new_session=True,
    )
    watcher = ChildProcessWatcher(proc.pid)
    watcher.start()
    return proc, script_file.name, watcher, result_path


def cancel_script(proc: subprocess.Popen, grace_s: float = 3.0,
                  result_path: str | None = None) -> dict[str, Any]:
    """Cancel a spawned engine process: SIGTERM, then SIGKILL if needed."""
    term_at = time.perf_counter()
    if proc.poll() is None:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            proc.terminate()
    try:
        proc.wait(timeout=grace_s)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            proc.kill()
        proc.wait()
    kill_latency_s = time.perf_counter() - term_at
    stdout, _ = proc.communicate()
    return {
        "returncode": proc.returncode,
        "term_to_dead_s": round(kill_latency_s, 4),
        "killed_after_grace": proc.returncode not in (0, -signal.SIGTERM),
        "produced_results": (
            bool(result_path) and os.path.exists(result_path)
        ),
    }


def finish_script(
    proc: subprocess.Popen, watcher: ChildProcessWatcher, script_path: str,
    result_path: str | None = None,
    timeout: float = 600.0,
) -> dict[str, Any]:
    """Wait for a spawned script and parse its results."""
    try:
        stdout, stderr = proc.communicate(timeout=timeout)
        result = _parse_results(result_path, stdout, proc.returncode, stderr)
    except subprocess.TimeoutExpired:
        _kill_group(proc)
        proc.communicate()
        raise EngineTimeout(timeout, "spawned script")
    finally:
        usage = watcher.finish()
        os.unlink(script_path)
        if result_path and os.path.exists(result_path):
            os.unlink(result_path)
    result["child_resources"] = usage.to_dict()
    return result


def _kill_group(proc: subprocess.Popen) -> None:
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        proc.kill()


def _parse_results(
    result_path: str | None, stdout: str, returncode: int, stderr: str
) -> dict[str, Any]:
    """Parse the file-transferred result payload (see SCRIPT_EPILOGUE)."""
    if result_path and os.path.exists(result_path):
        with open(result_path) as f:
            payload = json.load(f)
        payload.setdefault("checks", [])
        payload.setdefault("measurements", {})
        return payload
    raise EngineScriptError(
        (stderr or stdout or "no output")[-2000:], returncode
    )


def cold_start_script() -> str:
    """A trivial script used to measure engine process startup."""
    return (
        "import FreeCAD\n"
        "v = FreeCAD.Version()\n"
        "record('freecad/alive', 'FreeCAD engine process started and reports its version.', True,\n"
        "       details={'version': '.'.join(str(x) for x in v[:3])})\n"
        "measure('engine_import_ms_note', 'FreeCAD import happens before the prelude timer; see process_wall_ms')\n"
    )


def freecad_version(freecadcmd: str) -> dict:
    result = run_script(cold_start_script(), freecadcmd, timeout=120,
                        script_hint="version-probe")
    for check in result["checks"]:
        if check["id"] == "freecad/alive":
            return check["details"]
    raise RuntimeError(f"version probe failed: {result}")


# ---------------------------------------------------------------------------
# Engine workload scripts (fixtures + measured operations)
# ---------------------------------------------------------------------------

BUILD_DOC_SCRIPT = """
import FreeCAD as App
import json, os

TIER = json.loads('{tier_json}')
path = '{doc_path}'
doc = App.newDocument('bench')

with timed('engine_build_document_ms'):
    for i in range(TIER['walls']):
        wall = doc.addObject('Part::Box', f'Wall_{{i:04d}}')
        wall.Length = 4.0 + (i % 3) * 0.5
        wall.Width = 0.3
        wall.Height = 3.0
        wall.Placement.Base = App.Vector((i % 20) * 4.5, (i // 20) * 0.5, 0)
    for i in range(TIER['opening_cuts']):
        host = doc.getObject(f'Wall_{{i:04d}}')
        tool = doc.addObject('Part::Box', f'Opening_{{i:04d}}')
        tool.Length = 1.0
        tool.Width = 0.4
        tool.Height = 2.1
        tool.Placement.Base = host.Placement.Base + App.Vector(1.5, -0.05, 0.45)
        cut = doc.addObject('Part::Cut', f'Cut_{{i:04d}}')
        cut.Base = host
        cut.Tool = tool
    doc.recompute()

with timed('engine_save_ms'):
    doc.saveAs(path)

objs = len(doc.Objects)
record('doc/built', 'FCStd document built at tier scale.', True,
       details={{'tier': TIER['tier'], 'objects': objs,
                 'walls': TIER['walls'], 'cuts': TIER['opening_cuts']}})
measure('object_count', objs)
measure('doc_size_bytes', os.path.getsize(path))
App.closeDocument(doc.Name)
"""

OPEN_RECOMPUTE_SAVE_SCRIPT = """
import FreeCAD as App
import json, os

TIER = json.loads('{tier_json}')
path = '{doc_path}'
out_path = '{out_path}'
edits = TIER['edits']

with timed('engine_open_document_ms'):
    doc = App.openDocument(path)

with timed('engine_selection_query_ms'):
    walls = sorted(
        (o for o in doc.Objects if o.isDerivedFrom('Part::Box')),
        key=lambda o: o.Name,
    )
    first_volumes = [round(w.Shape.Volume, 6) for w in walls[:5]]

with timed('engine_parametric_edit_recompute_ms'):
    for i in range(edits):
        wall = doc.getObject(f'Wall_{{i * 7:04d}}') or walls[i * 7]
        wall.Length = wall.Length.Value + 0.25
    doc.recompute()

with timed('engine_full_recompute_ms'):
    for o in doc.Objects:
        o.touch()
    doc.recompute()

with timed('engine_save_as_ms'):
    doc.saveAs(out_path)

record('doc/roundtrip', 'FCStd open/parametric-edit/recompute/save completed.', True,
       details={{'tier': TIER['tier'], 'objects': len(doc.Objects),
                 'edited': edits,
                 'first_volumes_before': first_volumes}})
measure('volume_after_edit', round(walls[0].Shape.Volume, 6))
App.closeDocument(doc.Name)
"""

REOPEN_SCRIPT = """
import FreeCAD as App
import json

TIER = json.loads('{tier_json}')
path = '{doc_path}'
with timed('engine_reopen_ms'):
    doc = App.openDocument(path)
with timed('engine_reopen_selection_ms'):
    n = len(doc.Objects)
    vol = round(doc.getObject('Wall_0000').Shape.Volume, 6)
record('doc/reopened', 'Controlled save/reopen verification.', True,
       details={{'tier': TIER['tier'], 'objects': n, 'first_wall_volume': vol}})
App.closeDocument(doc.Name)
"""
