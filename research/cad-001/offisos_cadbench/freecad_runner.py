"""FreeCAD headless runner for the RESEARCH-CAD-001 benchmark.

Runs self-contained test scripts inside FreeCAD's bundled Python via
``FreeCADCmd`` (console mode, no display required) and returns structured
JSON results. This keeps every FreeCAD import inside the engine boundary:
benchmark modules never import FreeCAD in-process; they consume the typed
results.

Discovery order for the FreeCADCmd binary:
1. ``FREECADCMD`` environment variable (absolute path);
2. ``<repo>/research/cad-001/.freecad/squashfs-root/usr/bin/FreeCADCmd``
   (the documented AppImage extraction location — see README);
3. ``shutil.which("FreeCADCmd")``.

The AppImage itself is NOT committed to the repository (782 MB); its exact
version, source URL and SHA256 are recorded in the evidence instead, and
both ``make bench`` and CI install it reproducibly.

Scripts run via :func:`run_freecad_script` must be fully self-contained
(they execute inside FreeCAD's Python), must define a ``record(cid,
description, ok, epistemic, details)`` helper or otherwise collect checks,
and must end with ``print("@@RESULTS@@" + json.dumps(CHECKS))``. A
:func:`script_prelude` helper is provided for uniform error capture.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]  # research/cad-001

SCRIPT_PRELUDE = """
import json, sys, traceback

CHECKS = []

def record(cid, description, ok, epistemic="NATIVE", details=None):
    CHECKS.append({
        "id": cid,
        "description": description,
        "status": "pass" if ok else "fail",
        "epistemic": epistemic,
        "details": details or {},
    })
"""

SCRIPT_EPILOGUE = """
print("@@RESULTS@@" + json.dumps(CHECKS))
"""


def find_freecadcmd() -> str | None:
    env = os.environ.get("FREECADCMD")
    if env and Path(env).exists():
        return env
    for name in ("FreeCADCmd", "freecadcmd"):
        local = REPO_ROOT / ".freecad" / "squashfs-root" / "usr" / "bin" / name
        if local.exists():
            return str(local)
    for name in ("FreeCADCmd", "freecadcmd"):
        found = shutil.which(name)
        if found:
            return found
    return None


def freecad_version(freecadcmd: str) -> dict:
    """Return FreeCAD version information from the engine itself."""
    script = (
        SCRIPT_PRELUDE
        + "import FreeCAD\n"
        "v = FreeCAD.Version()\n"
        "record('freecad/version', 'FreeCAD engine reports its exact version.', True,\n"
        "       details={'version': '.'.join(str(x) for x in v[:3]),\n"
        "                'version_tuple': [int(x) for x in v[:3]],\n"
        "                'build_date': str(v[3]) if len(v) > 3 else '',\n"
        "                'build_commit': str(v[4]) if len(v) > 4 else ''})\n"
        + SCRIPT_EPILOGUE
    )
    checks = _run(freecadcmd, script)
    if not checks or checks[0]["status"] != "pass":
        raise RuntimeError(f"could not read FreeCAD version: {checks}")
    return checks[0]["details"]


def run_freecad_script(script_body: str, freecadcmd: str, timeout: int = 300) -> list[dict]:
    """Run ``script_body`` inside FreeCADCmd; return its recorded checks."""
    return _run(freecadcmd, SCRIPT_PRELUDE + script_body + SCRIPT_EPILOGUE, timeout)


def _run(freecadcmd: str, script: str, timeout: int = 300) -> list[dict]:
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".py", delete=False
    ) as script_file:
        script_file.write(script)
        script_path = script_file.name
    try:
        result = subprocess.run(
            [freecadcmd, "--console", script_path],
            capture_output=True, text=True, timeout=timeout,
            stdin=subprocess.DEVNULL,  # console mode must see EOF after the script
        )
        payload = None
        for line in result.stdout.splitlines():
            if line.startswith("@@RESULTS@@"):
                payload = line[len("@@RESULTS@@"):]
        if payload is None:
            raise RuntimeError(
                "FreeCAD script produced no results. "
                f"stderr tail: {result.stderr[-800:]}"
            )
        checks = json.loads(payload)
        if result.returncode != 0:
            checks.append({
                "id": "freecad/process-exit-code",
                "description": "FreeCADCmd exited cleanly (return code 0).",
                "status": "pass" if result.returncode == 0 else "fail",
                "epistemic": "OBSERVED",
                "details": {"returncode": result.returncode},
            })
        return checks
    finally:
        os.unlink(script_path)
